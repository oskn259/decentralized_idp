/**
 * A clock a test sets once. It is the node's and the gateway's `Clock`
 * (`{ nowSeconds(): number }`) at once, so one instance serves the whole live stack.
 */
export class TestClock {
  private readonly seconds: number;

  constructor(seconds: number) {
    this.seconds = seconds;
  }

  nowSeconds(): number {
    return this.seconds;
  }
}
