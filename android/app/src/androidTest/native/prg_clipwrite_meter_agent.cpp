/*
 * Test-only JVMTI agent: an exact entry counter for ONE framework method.
 *
 * WHAT THIS IS.  A minimal JVMTI agent loaded into the app's own debuggable test
 * process with the public android.os.Debug.attachJvmtiAgent API.  It installs a
 * JVMTI breakpoint at the ENTRY of exactly
 *
 *     android.content.ClipboardManager.setPrimaryClip(Landroid/content/ClipData;)V
 *
 * — the public Android SDK clipboard setter the production copy path calls — and
 * increments one monotonic 64-bit counter once per entry, on every thread.  It
 * reads nothing about the ClipData, records no timestamp, no thread, no content,
 * and applies no de-duplication of any kind: two identical writes inside the same
 * millisecond count two.
 *
 * WHAT THIS IS NOT.  It is not a product feature and it is never part of the
 * production application APK, the release build, or any shipped file: the source
 * lives under src/androidTest and the compiled library is packaged only into the
 * instrumented test APK.  It exposes no control protocol, no dynamic methods, no
 * host liveness or authority channel, and no way to write anything.  Its only
 * outputs are the counter, a bounded status line, and an install/cleared state.
 * It never touches the app, its context, its services, or its call chain: the
 * real ClipboardManager, its binder proxy, and the real system service stay
 * exactly as production calls them.
 *
 * FAIL CLOSED.  Every step that could make a count wrong is fatal to readiness:
 * a missing or ambiguous class/method/signature, a static, native, or abstract
 * target, a JVMTI version or capability the runtime does not give us, a failed
 * SetEventCallbacks / SetEventNotificationMode / SetBreakpoint, a counter that
 * would overflow, or a breakpoint firing for a method other than the exact
 * target.  When any of those happen the meter marks itself NOT ready and records
 * a precise error; the Kotlin wrapper (ClipWriteMeter.kt) refuses to run any test
 * against a not-ready meter.  A not-ready meter never reports a count of 0 as if
 * it were a measurement.
 *
 * ATTACH EXACTLY ONCE.  A second attach is refused rather than re-armed, because
 * a second breakpoint on the same method would count each entry twice.  The
 * counter is cumulative and deliberately has no reset: a test phase measures
 * deltas of one uninterrupted count, so there is no window in which a write could
 * hide.
 *
 * JVMTI HEADER.  The Android NDK ships jni.h but no jvmti.h, so this build puts
 * the standard OpenJDK JVMTI ABI header (JAVA_HOME/include) on the include path
 * and uses it unmodified — no vendored or copied third-party header.  Only
 * JVMTI 1.0-era entry points are called; those sit at the front of the function
 * table, which JVMTI extends by appending only, so the table layout does not have
 * to be guessed.  No function-table offset is hand-computed anywhere here.
 */

#include <jni.h>

#include <atomic>
#include <cstdarg>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <limits>
#include <mutex>
#include <string>
#include <thread>

#include <android/log.h>

// OpenJDK's standard JVMTI ABI header, supplied on the include path by the
// test-only native build task with -idirafter, so <jni.h> above still resolves
// to the NDK's own platform header.  jvmti.h's own `#include "jni.h"` would
// otherwise pick up the OpenJDK copy sitting next to it and then a host jni_md.h
// that does not exist for an Android target, so the build defines that copy's
// include guard (-D_JAVASOFT_JNI_H_) and the platform JNI types stay the NDK's.
// No third-party header is copied or vendored into this repository.
#include <jvmti.h>

#define PRG_LOG_TAG "PrgClipWriteMeter"
#define PRG_LOGI(...) __android_log_print(ANDROID_LOG_INFO, PRG_LOG_TAG, __VA_ARGS__)
#define PRG_LOGE(...) __android_log_print(ANDROID_LOG_ERROR, PRG_LOG_TAG, __VA_ARGS__)

namespace {

/* ------------------------------------------------------------------ *
 * The one target
 * ------------------------------------------------------------------ */

constexpr char kTargetClass[] = "android/content/ClipboardManager";
constexpr char kTargetClassSignature[] = "Landroid/content/ClipboardManager;";
constexpr char kTargetMethod[] = "setPrimaryClip";
constexpr char kTargetSignature[] = "(Landroid/content/ClipData;)V";

/** Breakpoint locations tried, in order, for "at method entry".
 *
 *  JVMTI identifies a location by code index; ART indexes dex code from 0, and
 *  some JVMTI implementations use -1 for the method-entry pseudo-location.  Both
 *  spellings mean the same thing here, so the first one the runtime accepts is
 *  recorded in the status line.  This is not ambiguity about WHICH method is
 *  instrumented: the method is resolved by exact class, name, and signature, and
 *  exactly one such method must exist. */
constexpr jlocation kEntryLocations[] = {0, -1};

/* ------------------------------------------------------------------ *
 * Meter state
 * ------------------------------------------------------------------ */

/** Breakpoint lifecycle, as reported to the test. */
enum BreakpointState : jint {
  kBreakpointNone = 0,
  kBreakpointInstalled = 1,
  kBreakpointCleared = 2,
};

struct MeterState {
  /** Entries of the exact target method, all threads, since attach. */
  std::atomic<jlong> total{0};
  /** True only while every install step succeeded and nothing invalidated it. */
  std::atomic<bool> ready{false};
  /** Attach is one-shot; a second attach is refused. */
  std::atomic<bool> attached{false};
  /** Close was requested; the meter reports a closed snapshot, never a live count. */
  std::atomic<bool> closed{false};
  /** Stop requested by the test; the breakpoint is then cleared on entry. */
  std::atomic<bool> stop_requested{false};
  std::atomic<jint> breakpoint_state{kBreakpointNone};
  /** The running VM, so any thread can ask for its own JVMTI environment. */
  std::atomic<JavaVM*> vm{nullptr};
  /**
   * The ONE JVMTI environment this agent owns: the environment Agent_OnAttach
   * received, on which AddCapabilities acquired can_generate_breakpoint_events,
   * SetEventCallbacks registered this callback, and SetBreakpoint installed the
   * breakpoint.
   *
   * Capabilities and event registrations belong to an environment, and a JVMTI
   * environment — unlike a JNIEnv — may be used from any thread. Teardown
   * therefore has to use THIS environment: a fresh one from JavaVM.GetEnv carries
   * none of our capabilities or registrations, so disabling events or clearing the
   * breakpoint through it would act on an unrelated environment and fail. It is
   * retained for the agent's whole lifetime; nothing here releases it.
   */
  jvmtiEnv* install_env{nullptr};
  /**
   * Breakpoint callbacks currently executing. Closing waits for this to reach zero
   * so the returned snapshot cannot still be moving.
   */
  std::atomic<jint> in_flight{0};
  /** Serialises close attempts; never held while the text lock is held. */
  std::mutex close_mutex;
  /** The resolved target method; written before `ready` is published. */
  jmethodID target_method{nullptr};
  /** Which entry-location spelling the runtime accepted. */
  jlocation breakpoint_location{-2};
  /** The JVMTI version the runtime handed back, and whether it reports
   *  can_generate_breakpoint_events. */
  jint jvmti_version{0};
  jboolean capability_breakpoints{JNI_FALSE};
  std::mutex text_mutex;
  std::string error;   // empty means "none"
  std::string detail;  // install summary for the report
};

MeterState g_state;

void SetError(const char* format, ...) {
  char buffer[512];
  va_list arguments;
  va_start(arguments, format);
  vsnprintf(buffer, sizeof(buffer), format, arguments);
  va_end(arguments);
  std::lock_guard<std::mutex> guard(g_state.text_mutex);
  if (g_state.error.empty()) g_state.error.assign(buffer);
}

void AppendDetail(const char* format, ...) {
  char buffer[512];
  va_list arguments;
  va_start(arguments, format);
  vsnprintf(buffer, sizeof(buffer), format, arguments);
  va_end(arguments);
  std::lock_guard<std::mutex> guard(g_state.text_mutex);
  if (!g_state.detail.empty()) g_state.detail.push_back(' ');
  g_state.detail.append(buffer);
}

/** Named form of the JVMTI error codes this agent can see. Only names the
 *  standard header actually declares are listed; anything else is reported by
 *  number so a message can never invent a meaning. */
const char* JvmtiErrorName(jvmtiError error) {
  switch (error) {
    case JVMTI_ERROR_NONE: return "NONE";
    case JVMTI_ERROR_INVALID_CLASS: return "INVALID_CLASS";
    case JVMTI_ERROR_CLASS_NOT_PREPARED: return "CLASS_NOT_PREPARED";
    case JVMTI_ERROR_INVALID_METHODID: return "INVALID_METHODID";
    case JVMTI_ERROR_INVALID_LOCATION: return "INVALID_LOCATION";
    case JVMTI_ERROR_NO_MORE_FRAMES: return "NO_MORE_FRAMES";
    case JVMTI_ERROR_DUPLICATE: return "DUPLICATE";
    case JVMTI_ERROR_NOT_FOUND: return "NOT_FOUND";
    case JVMTI_ERROR_NOT_AVAILABLE: return "NOT_AVAILABLE";
    case JVMTI_ERROR_MUST_POSSESS_CAPABILITY: return "MUST_POSSESS_CAPABILITY";
    case JVMTI_ERROR_NULL_POINTER: return "NULL_POINTER";
    case JVMTI_ERROR_ABSENT_INFORMATION: return "ABSENT_INFORMATION";
    case JVMTI_ERROR_ILLEGAL_ARGUMENT: return "ILLEGAL_ARGUMENT";
    case JVMTI_ERROR_NATIVE_METHOD: return "NATIVE_METHOD";
    case JVMTI_ERROR_CLASS_LOADER_UNSUPPORTED: return "CLASS_LOADER_UNSUPPORTED";
    case JVMTI_ERROR_OUT_OF_MEMORY: return "OUT_OF_MEMORY";
    case JVMTI_ERROR_ACCESS_DENIED: return "ACCESS_DENIED";
    case JVMTI_ERROR_WRONG_PHASE: return "WRONG_PHASE";
    case JVMTI_ERROR_INTERNAL: return "INTERNAL";
    case JVMTI_ERROR_UNATTACHED_THREAD: return "UNATTACHED_THREAD";
    case JVMTI_ERROR_INVALID_ENVIRONMENT: return "INVALID_ENVIRONMENT";
    default: return "UNMAPPED";
  }
}

/** Class-file access flags, from JVMS 4.1 (Table 4.1-B). These values are fixed
 *  by the Java Virtual Machine Specification, not by one VM implementation. */
constexpr jint kAccessPublic = 0x0001;
constexpr jint kAccessStatic = 0x0008;
constexpr jint kAccessNative = 0x0100;
constexpr jint kAccessAbstract = 0x0400;

/** A bounded single-line description of everything this meter knows. */
std::string StatusLine() {
  char counters[256];
  snprintf(
      counters,
      sizeof(counters),
      "ready=%d breakpoint=%d total=%lld closed=%d stop=%d location=%lld jvmtiVersion=%d "
      "canGenerateBreakpointEvents=%d",
      g_state.ready.load(std::memory_order_acquire) ? 1 : 0,
      static_cast<int>(g_state.breakpoint_state.load(std::memory_order_acquire)),
      static_cast<long long>(g_state.total.load(std::memory_order_acquire)),
      g_state.closed.load(std::memory_order_acquire) ? 1 : 0,
      g_state.stop_requested.load(std::memory_order_acquire) ? 1 : 0,
      static_cast<long long>(g_state.breakpoint_location),
      g_state.jvmti_version,
      static_cast<int>(g_state.capability_breakpoints));
  std::lock_guard<std::mutex> guard(g_state.text_mutex);
  std::string status(counters);
  status += " target=";
  status += kTargetClass;
  status += ".";
  status += kTargetMethod;
  status += kTargetSignature;
  status += " errors=";
  status += g_state.error.empty() ? "none" : g_state.error.c_str();
  if (!g_state.detail.empty()) {
    status += " detail=";
    status += g_state.detail;
  }
  return status;
}

/* ------------------------------------------------------------------ *
 * The breakpoint callback: the whole measurement
 * ------------------------------------------------------------------ */

/**
 * Counts this callback as in flight for as long as it runs, so a close can wait
 * for callbacks that already started before it reads the final count.
 */
class InFlightGuard {
 public:
  InFlightGuard() { g_state.in_flight.fetch_add(1, std::memory_order_seq_cst); }
  ~InFlightGuard() { g_state.in_flight.fetch_sub(1, std::memory_order_seq_cst); }
  InFlightGuard(const InFlightGuard&) = delete;
  InFlightGuard& operator=(const InFlightGuard&) = delete;
};

void JNICALL OnBreakpoint(
    jvmtiEnv* /*env*/, JNIEnv* /*jni_env*/, jthread /*thread*/, jmethodID method, jlocation /*location*/) {
  // The entry is counted first, so a write that races the close belongs in the
  // final number instead of disappearing from it; the guard then keeps this
  // callback visible to a close that is waiting for the count to stop moving.
  InFlightGuard in_flight;
  const jlong previous = g_state.total.fetch_add(1, std::memory_order_relaxed);
  if (previous < 0 || previous == std::numeric_limits<jlong>::max()) {
    // A counter this large is not a measurement any more. Say so and stop
    // claiming readiness rather than keep wrapping.
    g_state.ready.store(false, std::memory_order_release);
    SetError("write counter overflowed at %lld entries", static_cast<long long>(previous));
    return;
  }
  if (method != g_state.target_method) {
    // Only one breakpoint is ever installed, and only at the exact target.
    // Anything else means this meter cannot vouch for its own count.
    g_state.ready.store(false, std::memory_order_release);
    SetError("breakpoint fired for a method other than the exact target");
    return;
  }
  if (g_state.closed.load(std::memory_order_acquire)) {
    // The close removed the breakpoint and disabled this event. An entry here
    // means the meter is not the mechanism it claims to be, so it says so.
    g_state.ready.store(false, std::memory_order_release);
    SetError("target method was entered after the meter closed");
  }
}

/* ------------------------------------------------------------------ *
 * Installation
 * ------------------------------------------------------------------ */

/**
 * Locate the target class.
 *
 * JVMTI has no FindClass, so the JNI one is used: it resolves through the loader
 * of the frame that called Debug.attachJvmtiAgent, which is the framework's own
 * Debug method, i.e. the platform loader that owns android.content.ClipboardManager.
 * If that ever yields nothing, the JVMTI list of loaded classes is searched for
 * exactly one class with this signature. Both routes failing is a hard failure.
 */
jclass FindTargetClass(jvmtiEnv* env, JavaVM* vm) {
  JNIEnv* jni_env = nullptr;
  if (vm->AttachCurrentThread(&jni_env, nullptr) == JNI_OK && jni_env != nullptr) {
    jclass clazz = jni_env->FindClass(kTargetClass);
    if (clazz != nullptr) return clazz;
    jni_env->ExceptionClear();
    AppendDetail("jniFindClass=none");
  } else {
    AppendDetail("jniAttachForFindClass=none");
  }
  jint class_count = 0;
  jclass* classes = nullptr;
  if (env->GetLoadedClasses(&class_count, &classes) != JVMTI_ERROR_NONE || classes == nullptr) {
    SetError("neither JNI FindClass nor GetLoadedClasses located %s", kTargetClass);
    return nullptr;
  }
  int matches = 0;
  jclass found = nullptr;
  for (jint index = 0; index < class_count; index += 1) {
    char* signature = nullptr;
    char* generic = nullptr;
    if (env->GetClassSignature(classes[index], &signature, &generic) != JVMTI_ERROR_NONE) {
      continue;
    }
    if (signature != nullptr && strcmp(signature, kTargetClassSignature) == 0) {
      matches += 1;
      found = classes[index];
    }
    if (signature != nullptr) env->Deallocate(reinterpret_cast<unsigned char*>(signature));
    if (generic != nullptr) env->Deallocate(reinterpret_cast<unsigned char*>(generic));
  }
  env->Deallocate(reinterpret_cast<unsigned char*>(classes));
  if (matches != 1) {
    SetError("the loaded-class search matched %d classes with signature %s (exactly 1 required)",
             matches, kTargetClassSignature);
    return nullptr;
  }
  AppendDetail("classLocatedBy=loadedClasses");
  return found;
}

/** Resolve the single exact target method, or record why not. */
jmethodID ResolveTargetMethod(jvmtiEnv* env, JavaVM* vm) {
  jclass clazz = FindTargetClass(env, vm);
  if (clazz == nullptr) return nullptr;
  jint method_count = 0;
  jmethodID* methods = nullptr;
  jvmtiError error = env->GetClassMethods(clazz, &method_count, &methods);
  if (error != JVMTI_ERROR_NONE || methods == nullptr) {
    SetError("GetClassMethods(%s) failed: %s(%d)", kTargetClass, JvmtiErrorName(error), static_cast<int>(error));
    return nullptr;
  }

  int exact_matches = 0;
  jmethodID chosen = nullptr;
  for (jint index = 0; index < method_count; index += 1) {
    char* name = nullptr;
    char* signature = nullptr;
    char* generic = nullptr;
    error = env->GetMethodName(methods[index], &name, &signature, &generic);
    if (error != JVMTI_ERROR_NONE) {
      continue;
    }
    const bool matches = name != nullptr && signature != nullptr &&
        strcmp(name, kTargetMethod) == 0 && strcmp(signature, kTargetSignature) == 0;
    if (matches) {
      exact_matches += 1;
      chosen = methods[index];
    }
    if (name != nullptr) env->Deallocate(reinterpret_cast<unsigned char*>(name));
    if (signature != nullptr) env->Deallocate(reinterpret_cast<unsigned char*>(signature));
    if (generic != nullptr) env->Deallocate(reinterpret_cast<unsigned char*>(generic));
  }
  env->Deallocate(reinterpret_cast<unsigned char*>(methods));

  if (exact_matches != 1) {
    SetError("%s.%s%s matched %d methods (exactly 1 is required)",
             kTargetClass, kTargetMethod, kTargetSignature, exact_matches);
    return nullptr;
  }

  jint modifiers = 0;
  error = env->GetMethodModifiers(chosen, &modifiers);
  if (error != JVMTI_ERROR_NONE) {
    SetError("GetMethodModifiers failed: %s(%d)", JvmtiErrorName(error), static_cast<int>(error));
    return nullptr;
  }
  if ((modifiers & kAccessStatic) != 0 || (modifiers & kAccessNative) != 0 ||
      (modifiers & kAccessAbstract) != 0) {
    SetError("target is static, native, or abstract (modifiers 0x%x): no entry code to break on",
             static_cast<unsigned>(modifiers));
    return nullptr;
  }
  if ((modifiers & kAccessPublic) == 0) {
    // The counted method is the public SDK setter. A non-public method under
    // this name and signature is not the thing the acceptance claim is about.
    SetError("target is not public (modifiers 0x%x)", static_cast<unsigned>(modifiers));
    return nullptr;
  }

  jclass declaring = nullptr;
  error = env->GetMethodDeclaringClass(chosen, &declaring);
  if (error != JVMTI_ERROR_NONE || declaring == nullptr) {
    SetError("GetMethodDeclaringClass failed: %s(%d)", JvmtiErrorName(error), static_cast<int>(error));
    return nullptr;
  }
  char* class_signature = nullptr;
  char* generic_signature = nullptr;
  error = env->GetClassSignature(declaring, &class_signature, &generic_signature);
  const bool declaring_matches = error == JVMTI_ERROR_NONE && class_signature != nullptr &&
      strcmp(class_signature, kTargetClassSignature) == 0;
  if (class_signature != nullptr) env->Deallocate(reinterpret_cast<unsigned char*>(class_signature));
  if (generic_signature != nullptr) env->Deallocate(reinterpret_cast<unsigned char*>(generic_signature));
  if (!declaring_matches) {
    SetError("the matched method is not declared by %s", kTargetClass);
    return nullptr;
  }

  AppendDetail("modifiers=0x%x", static_cast<unsigned>(modifiers));
  return chosen;
}

bool Install(jvmtiEnv* env, JavaVM* vm) {
  // 1. The capability the mechanism depends on. If the runtime will not report
  //    breakpoint support, the meter refuses to claim a measurement.
  jvmtiCapabilities capabilities;
  memset(&capabilities, 0, sizeof(capabilities));
  capabilities.can_generate_breakpoint_events = 1;
  jvmtiError error = env->AddCapabilities(&capabilities);
  if (error != JVMTI_ERROR_NONE) {
    SetError("AddCapabilities(can_generate_breakpoint_events) failed: %s(%d)",
             JvmtiErrorName(error), static_cast<int>(error));
    return false;
  }
  memset(&capabilities, 0, sizeof(capabilities));
  error = env->GetCapabilities(&capabilities);
  if (error != JVMTI_ERROR_NONE) {
    SetError("GetCapabilities failed: %s(%d)", JvmtiErrorName(error), static_cast<int>(error));
    return false;
  }
  g_state.capability_breakpoints = capabilities.can_generate_breakpoint_events;
  if (capabilities.can_generate_breakpoint_events != 1) {
    SetError("runtime does not report can_generate_breakpoint_events after AddCapabilities");
    return false;
  }

  // 2. The exact target method.
  jmethodID method = ResolveTargetMethod(env, vm);
  if (method == nullptr) return false;
  g_state.target_method = method;

  // 3. Register the callback and enable breakpoint events BEFORE the breakpoint
  //    exists, so no entry can slip in between the two.
  jvmtiEventCallbacks callbacks;
  memset(&callbacks, 0, sizeof(callbacks));
  callbacks.Breakpoint = &OnBreakpoint;
  error = env->SetEventCallbacks(&callbacks, static_cast<jint>(sizeof(callbacks)));
  if (error != JVMTI_ERROR_NONE) {
    SetError("SetEventCallbacks failed: %s(%d)", JvmtiErrorName(error), static_cast<int>(error));
    return false;
  }
  error = env->SetEventNotificationMode(JVMTI_ENABLE, JVMTI_EVENT_BREAKPOINT, nullptr);
  if (error != JVMTI_ERROR_NONE) {
    SetError("SetEventNotificationMode(BREAKPOINT) failed: %s(%d)",
             JvmtiErrorName(error), static_cast<int>(error));
    return false;
  }

  // 4. The breakpoint itself, at entry.
  jvmtiError last_error = JVMTI_ERROR_INVALID_LOCATION;
  for (jlocation location : kEntryLocations) {
    error = env->SetBreakpoint(method, location);
    if (error == JVMTI_ERROR_NONE) {
      g_state.breakpoint_location = location;
      g_state.breakpoint_state.store(kBreakpointInstalled, std::memory_order_release);
      AppendDetail("breakpointLocation=%lld", static_cast<long long>(location));
      return true;
    }
    last_error = error;
  }
  SetError("SetBreakpoint failed at every entry-location spelling: %s(%d)",
           JvmtiErrorName(last_error), static_cast<int>(last_error));
  return false;
}

/** The environment JVMTI hands to this thread, at a version this runtime supports. */
jvmtiEnv* CurrentEnvironment(JavaVM* vm) {
  constexpr jint kVersions[] = {JVMTI_VERSION_1_2, JVMTI_VERSION_1_1, JVMTI_VERSION_1_0};
  for (jint version : kVersions) {
    void* environment = nullptr;
    if (vm->GetEnv(&environment, version) == JNI_OK && environment != nullptr) {
      g_state.jvmti_version = version;
      AppendDetail("requestedVersion=0x%x", static_cast<unsigned>(version));
      return static_cast<jvmtiEnv*>(environment);
    }
  }
  return nullptr;
}

/**
 * Close the meter and return its final count as a closed snapshot.
 *
 * Closing is real teardown, not a flag. It uses the agent's OWN installation
 * environment — the one Agent_OnAttach received, on which AddCapabilities acquired
 * can_generate_breakpoint_events, SetEventCallbacks registered this callback, and
 * SetBreakpoint installed the breakpoint. JVMTI capabilities and event
 * registrations belong to an environment, and a JVMTI environment, unlike a
 * JNIEnv, may be used from any thread; a freshly requested environment would own
 * neither the capability nor the registration, so tearing down through it would
 * act on something unrelated and fail. That environment disables breakpoint
 * events and clears the breakpoint here.
 *
 * The count is then frozen in order: events off, breakpoint gone, then a bounded
 * wait for callbacks that were already inside, then the read. Readiness is
 * withdrawn, so no later read can claim a live measurement, and the caller gets a
 * snapshot that cannot move afterwards. A write that raced the close is counted
 * into that number rather than dropped from it.
 *
 * Fails closed: a missing installation environment, a failed disable, a failed
 * clear, or callbacks that never drained leave the reason in the status and return
 * -1, so the caller cannot mistake a broken teardown for a trustworthy count.
 */
jlong CloseMeter() {
  std::lock_guard<std::mutex> close_guard(g_state.close_mutex);
  if (g_state.closed.load(std::memory_order_acquire)) {
    SetError("close requested twice: the meter closed once and does not close again");
    return -1;
  }
  g_state.stop_requested.store(true, std::memory_order_release);
  jvmtiEnv* env = g_state.install_env;
  if (env == nullptr) {
    SetError("close: the agent never stored an installation JVMTI environment");
    g_state.ready.store(false, std::memory_order_release);
    g_state.closed.store(true, std::memory_order_release);
    return -1;
  }
  const jvmtiError disable_error =
      env->SetEventNotificationMode(JVMTI_DISABLE, JVMTI_EVENT_BREAKPOINT, nullptr);
  if (disable_error != JVMTI_ERROR_NONE) {
    SetError("close: disabling breakpoint events failed: %s(%d)",
             JvmtiErrorName(disable_error), static_cast<int>(disable_error));
  }
  if (g_state.breakpoint_state.load(std::memory_order_acquire) == kBreakpointInstalled) {
    const jvmtiError clear_error = env->ClearBreakpoint(g_state.target_method, g_state.breakpoint_location);
    if (clear_error == JVMTI_ERROR_NONE) {
      g_state.breakpoint_state.store(kBreakpointCleared, std::memory_order_release);
      AppendDetail("breakpointCleared=onClose");
    } else {
      SetError("close: ClearBreakpoint failed: %s(%d)",
               JvmtiErrorName(clear_error), static_cast<int>(clear_error));
    }
  }
  // Events are off and the breakpoint is gone, so nothing new can enter here. A
  // callback that was already inside is allowed to finish its increment; waiting
  // for those is what makes the returned number final rather than nearly final.
  const std::chrono::steady_clock::time_point deadline =
      std::chrono::steady_clock::now() + std::chrono::seconds(2);
  while (g_state.in_flight.load(std::memory_order_seq_cst) > 0) {
    if (std::chrono::steady_clock::now() >= deadline) {
      SetError("close: %d breakpoint callback(s) still in flight after 2s, so the count is not final",
               static_cast<int>(g_state.in_flight.load(std::memory_order_seq_cst)));
      break;
    }
    std::this_thread::yield();
  }
  const jlong final_total = g_state.total.load(std::memory_order_acquire);
  g_state.ready.store(false, std::memory_order_release);
  g_state.closed.store(true, std::memory_order_release);
  if (!g_state.error.empty()) return -1;
  return final_total;
}

}  // namespace

/* ------------------------------------------------------------------ *
 * Agent entry points
 * ------------------------------------------------------------------ */

extern "C" JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void* /*reserved*/) {
  g_state.vm.store(vm, std::memory_order_release);
  AppendDetail("jniOnLoad=ok");
  return JNI_VERSION_1_6;
}

/**
 * Attach the meter to the running process.
 *
 * This returns JNI_OK even when installation failed. Returning an error makes
 * ART unload the library, which would take the diagnostics — and the reason for
 * the failure — away with it. Readiness is the gate instead: ClipWriteMeter.kt
 * reads the status and fails the test closed on any error.
 */
extern "C" JNIEXPORT jint JNICALL Agent_OnAttach(JavaVM* vm, char* options, void* /*reserved*/) {
  (void)options;
  g_state.vm.store(vm, std::memory_order_release);
  bool expected = false;
  if (!g_state.attached.compare_exchange_strong(expected, true)) {
    // A second breakpoint on the same method would double every count.
    SetError("agent attached twice: the meter is one-shot and cannot be re-armed");
    PRG_LOGE("attach refused: %s", StatusLine().c_str());
    return JNI_OK;
  }
  jvmtiEnv* env = CurrentEnvironment(vm);
  if (env == nullptr) {
    SetError("JavaVM.GetEnv returned no JVMTI environment at any supported version");
    PRG_LOGE("attach failed: %s", StatusLine().c_str());
    return JNI_OK;
  }
  // Stored before anything is installed, so teardown always has the environment
  // that owns this agent's capabilities and registrations, even if installation
  // fails partway.
  g_state.install_env = env;
  if (!Install(env, vm)) {
    PRG_LOGE("attach failed: %s", StatusLine().c_str());
    return JNI_OK;
  }
  g_state.ready.store(true, std::memory_order_release);
  PRG_LOGI("attach ok: %s", StatusLine().c_str());
  return JNI_OK;
}

/**
 * Best-effort cleanup if the runtime ever detaches the agent. The breakpoint is
 * cleared with the agent's own installation environment — the one holding the
 * capability and the event registration — never a freshly requested one.
 */
extern "C" JNIEXPORT void JNICALL Agent_OnDetach(JavaVM* /*vm*/) {
  if (g_state.breakpoint_state.load(std::memory_order_acquire) != kBreakpointInstalled) return;
  jvmtiEnv* env = g_state.install_env;
  if (env == nullptr) {
    SetError("Agent_OnDetach has no installation JVMTI environment to clear the breakpoint with");
    return;
  }
  const jvmtiError error = env->ClearBreakpoint(g_state.target_method, g_state.breakpoint_location);
  if (error == JVMTI_ERROR_NONE) {
    g_state.breakpoint_state.store(kBreakpointCleared, std::memory_order_release);
    AppendDetail("breakpointCleared=onDetach");
  } else {
    SetError("Agent_OnDetach ClearBreakpoint failed: %s(%d)",
             JvmtiErrorName(error), static_cast<int>(error));
  }
}

/* ------------------------------------------------------------------ *
 * JNI surface the test reads (one library, one process, no channel)
 * ------------------------------------------------------------------ */

extern "C" JNIEXPORT jboolean JNICALL
Java_io_github_rfairburn_pireviewgate_androidtest_ClipWriteMeter_nativeIsReady(
    JNIEnv* /*env*/, jobject /*thiz*/) {
  return g_state.ready.load(std::memory_order_acquire) ? JNI_TRUE : JNI_FALSE;
}

extern "C" JNIEXPORT jlong JNICALL
Java_io_github_rfairburn_pireviewgate_androidtest_ClipWriteMeter_nativeReadTotal(
    JNIEnv* /*env*/, jobject /*thiz*/) {
  // -1 means "there is no measurement", never "zero writes happened".
  if (!g_state.ready.load(std::memory_order_acquire)) return -1;
  return g_state.total.load(std::memory_order_acquire);
}

extern "C" JNIEXPORT jboolean JNICALL
Java_io_github_rfairburn_pireviewgate_androidtest_ClipWriteMeter_nativeBreakpointInstalled(
    JNIEnv* /*env*/, jobject /*thiz*/) {
  return g_state.breakpoint_state.load(std::memory_order_acquire) == kBreakpointInstalled
      ? JNI_TRUE
      : JNI_FALSE;
}

extern "C" JNIEXPORT jstring JNICALL
Java_io_github_rfairburn_pireviewgate_androidtest_ClipWriteMeter_nativeStatus(
    JNIEnv* env, jobject /*thiz*/) {
  const std::string status = StatusLine();
  jstring result = env->NewStringUTF(status.c_str());
  if (result == nullptr) {
    env->ExceptionClear();
    return env->NewStringUTF("ready=0 errors=status string could not be created");
  }
  return result;
}

/** Ask the meter to close. Returns the final count, or -1 if closing failed. */
extern "C" JNIEXPORT jlong JNICALL
Java_io_github_rfairburn_pireviewgate_androidtest_ClipWriteMeter_nativeRequestStop(
    JNIEnv* /*env*/, jobject /*thiz*/) {
  return CloseMeter();
}
