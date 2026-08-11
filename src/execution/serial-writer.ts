/**
 * Orders asynchronous publications without poisoning the queue after one
 * failed write. Each caller observes its own failure; later writes still run.
 */
export class SerialWriter<T> {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly publish: (value: T) => Promise<void>) {}

  write(value: T): Promise<void> {
    const operation = this.tail.then(() => this.publish(value));
    this.tail = operation.catch(() => undefined);
    return operation;
  }

  async drain(): Promise<void> {
    await this.tail;
  }
}
