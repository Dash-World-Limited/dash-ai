import type { PushPayload, PushPlatform } from "@dash-ai/contracts";
import type { PushSendOptions, PushSendResult, PushTarget, PushTransport } from "./types.js";

export interface FakePush {
  token: string;
  payload: PushPayload;
  ttlSeconds: number;
}

/**
 * Records pushes instead of sending them: automated tests (no push credentials in CI) and local
 * development with PUSH_TRANSPORT=fake. `script` decides the outcome of each send.
 */
export class FakePushTransport implements PushTransport {
  readonly name = "fake";
  readonly sent: FakePush[] = [];
  /** Every attempt, accepted or not. */
  readonly attempts: FakePush[] = [];
  script: (target: PushTarget, payload: PushPayload) => PushSendResult | Promise<PushSendResult> = () => ({ ok: true });

  constructor(readonly platform: PushPlatform = "android") {}

  async send(target: PushTarget, payload: PushPayload, options: PushSendOptions): Promise<PushSendResult> {
    const push = { token: target.token, payload, ttlSeconds: options.ttlSeconds };
    this.attempts.push(push);
    const result = await this.script(target, payload);
    if (result.ok) this.sent.push(push);
    return result;
  }
}
