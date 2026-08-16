import { createHash } from "node:crypto";
import type { PendingModelDelivery, ReviewGateState } from "./state";

export type NewModelDelivery = Omit<PendingModelDelivery, "deliveryId" | "status" | "createdAt"> & {
  deliveryId?: string;
};

export function modelDeliveryId(delivery: Pick<PendingModelDelivery, "kind" | "channel" | "message" | "invocationDir" | "action">): string {
  return createHash("sha256").update(JSON.stringify([
    delivery.kind,
    delivery.channel,
    delivery.invocationDir ?? "",
    delivery.action ?? "",
    delivery.message,
  ])).digest("hex");
}

export function queueModelDelivery(state: ReviewGateState, input: NewModelDelivery): PendingModelDelivery {
  const deliveryId = input.deliveryId ?? modelDeliveryId(input);
  const existing = state.pendingModelDeliveries.find((delivery) => delivery.deliveryId === deliveryId);
  if (existing) return existing;
  const delivery: PendingModelDelivery = {
    ...input,
    deliveryId,
    status: "queued",
    createdAt: new Date().toISOString(),
  };
  state.pendingModelDeliveries.push(delivery);
  return delivery;
}

export async function dispatchModelDelivery(input: {
  delivery: PendingModelDelivery;
  persist: () => void | Promise<void>;
  deliver: () => Promise<boolean>;
}): Promise<boolean> {
  if (input.delivery.status === "delivered") return true;
  if (input.delivery.status === "cancelled") return false;
  if (input.delivery.status === "dispatching" || input.delivery.status === "uncertain") {
    throw new Error(`Delivery ${input.delivery.deliveryId} has an uncertain prior dispatch and cannot be duplicated automatically.`);
  }
  input.delivery.status = "dispatching";
  input.delivery.dispatchStartedAt = new Date().toISOString();
  input.delivery.diagnostic = undefined;
  await input.persist();
  try {
    const delivered = await input.deliver();
    if (delivered) {
      input.delivery.status = "delivered";
      input.delivery.deliveredAt = new Date().toISOString();
    } else {
      input.delivery.status = "queued";
      input.delivery.dispatchStartedAt = undefined;
    }
    await input.persist();
    return delivered;
  } catch (error) {
    input.delivery.status = "uncertain";
    input.delivery.diagnostic = error instanceof Error ? error.message : String(error);
    await input.persist();
    throw error;
  }
}
