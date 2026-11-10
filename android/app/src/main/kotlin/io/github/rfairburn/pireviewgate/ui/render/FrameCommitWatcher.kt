package io.github.rfairburn.pireviewgate.ui.render

import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.ViewTreeObserver
import io.github.rfairburn.pireviewgate.core.input.CommitCallbackCoordinator

/**
 * Bridges one View to the platform's frame-commit callback.
 *
 * The platform's public [ViewTreeObserver.registerFrameCommitCallback] fires when
 * the render thread has finished drawing the hierarchy and has submitted the
 * frame. That is the honest ceiling of what this can tell anyone: it is not a
 * guarantee that the frame is lit on a physical display, and nothing built on it
 * claims otherwise. It is the same floor the owning terminal applies to its own
 * committed writes, and the reason a receipt is named "committed" rather than
 * "visible".
 *
 * The registration is one-shot — the observer drops the callback after dispatch —
 * so every draw pass registers its own callback, and [awaitCommit] withdraws the
 * previous one first. Each callback closes over its own immutable
 * [CommitCallbackCoordinator.Registration], so a callback that was already
 * captured — for a pass whose frame was retired or superseded — reports nothing
 * and can never consume a newer request's draw epoch. Withdrawing also unregisters
 * from the observer, so nothing is left pending for a frame nobody wants.
 *
 * ## Threading
 *
 * The platform does not promise which thread dispatches the callback, and
 * everything downstream of it — the coordinator, the view, the renderer, and the
 * caller's listener — belongs to the main thread. So the dispatched callback does
 * exactly one thing: it posts to the main thread. The posted block then re-checks
 * the registration epoch it captured, and reports nothing unless that epoch is
 * still the live one. A commit that lands late — after [cancel], after a rebind,
 * after the view was detached, or after a newer draw pass began — therefore cannot
 * revive its own pass or replace a newer proof. Nothing is touched off the main
 * thread, and no lock is held across the hand-off: the guard is one comparison of
 * a counter that only the main thread changes.
 *
 * When the view is not hardware accelerated the platform never invokes the
 * callback at all; rather than pretending, [isCommitReportingAvailable] reports
 * false and the caller fails closed.
 *
 * Reusable beyond the terminal: any native dialog that must only act on pixels it
 * can prove were submitted uses this same gate.
 */
class FrameCommitWatcher(
	private val view: View,
	onCommit: (drawEpoch: Long) -> Unit,
) {
	private val coordinator = CommitCallbackCoordinator(onCommit)
	private val mainHandler = Handler(Looper.getMainLooper())
	private var registeredCallback: Runnable? = null
	private var registeredObserver: ViewTreeObserver? = null

	/**
	 * Bumped by every withdrawal and every new request, so a callback that was
	 * already in flight can be recognised as stale on the main thread.
	 */
	@Volatile
	private var registrationEpoch = 0L

	/** Whether the platform can report commits for this view at all. */
	val isCommitReportingAvailable: Boolean
		get() = view.isHardwareAccelerated

	/**
	 * Ask for the commit of draw pass [drawEpoch]. Any earlier pass is withdrawn
	 * and unregistered, so the newest draw is always the one that can report.
	 */
	fun awaitCommit(drawEpoch: Long) {
		cancel()
		if (!isCommitReportingAvailable) return
		val observer = view.viewTreeObserver.takeIf { it.isAlive } ?: return
		val registration = coordinator.begin(drawEpoch)
		val epoch = registrationEpoch
		val callback = Runnable { deliverOnMain(registration, epoch) }
		registeredCallback = callback
		registeredObserver = observer
		observer.registerFrameCommitCallback(callback)
	}

	/** Withdraw any pending request, for example when a frame is retired. */
	fun cancel() {
		registrationEpoch += 1
		coordinator.withdraw()
		val callback = registeredCallback
		val observer = registeredObserver
		registeredCallback = null
		registeredObserver = null
		if (callback != null && observer != null && observer.isAlive) {
			observer.unregisterFrameCommitCallback(callback)
		}
	}

	/**
	 * Move the platform's confirmation onto the main thread, wherever it arrived.
	 *
	 * Already on the main thread, the hand-off is direct; otherwise it is posted,
	 * and the only thing between the dispatch and the posted block is the epoch
	 * check below.
	 */
	private fun deliverOnMain(registration: CommitCallbackCoordinator.Registration, epoch: Long) {
		if (Looper.myLooper() == Looper.getMainLooper()) {
			applyOnMain(registration, epoch)
			return
		}
		mainHandler.post { applyOnMain(registration, epoch) }
	}

	private fun applyOnMain(registration: CommitCallbackCoordinator.Registration, epoch: Long) {
		// The coordinator is main-thread state, so this comparison is the whole
		// guard: a stale posted commit finds a different epoch and stops.
		if (epoch != registrationEpoch) return
		registration.report()
	}
}
