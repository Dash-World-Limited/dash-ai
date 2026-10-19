import { estimateTokensForLedger } from "./ledger.js";

/**
 * The worst case of one answer, in the same estimated tokens (about three characters per token) the
 * inference ledger uses: what a paid provider is admitted against under a spend limit, and what the
 * orchestrator then holds every provider request of that answer to.
 *
 * An answer that offers tools makes up to `toolRounds + 1` provider requests (its tool rounds, then a
 * final answer with tool use off). Each request re-sends everything before it, so round k may send at
 * most the first request plus k rounds of growth (the model's earlier output and the tool results),
 * and never more than the provider's context window.
 */
export interface ToolLoop {
  /** TOOL_MAX_ROUNDS: tool rounds before the final answer. */
  toolRounds: number;
  /** The most tool-result characters one round can add (every executed call at its result bound, plus a margin). */
  resultCharsPerRound: number;
}

/**
 * Characters assumed per output token when the model's own output is sent back in the next round.
 * Typical text is about four; a round whose output was longer than this is still held to the budget
 * at run time (see roundInputBudgets), so this only decides how much room the budget leaves.
 */
export const RESENT_CHARS_PER_OUTPUT_TOKEN = 4;

/** Estimated input tokens one tool round may add: its own output sent back plus its tool results. */
export function roundGrowthTokens(outputTokenCap: number, loop: ToolLoop): number {
  return estimateTokensForLedger(outputTokenCap * RESENT_CHARS_PER_OUTPUT_TOKEN + loop.resultCharsPerRound);
}

/**
 * Estimated input tokens each provider request of one answer may send, in round order. Round 0 is the
 * first request as admitted; later rounds grow by `growthTokens` each, capped at the context window
 * (never below the first request, which was already admitted on its own size).
 */
export function roundInputBudgets(firstInputTokens: number, opts: { rounds: number; growthTokens: number; contextTokens: number }): number[] {
  const rounds = Math.max(1, opts.rounds);
  return Array.from({ length: rounds }, (_, k) => Math.max(firstInputTokens, Math.min(opts.contextTokens, firstInputTokens + k * opts.growthTokens)));
}

/** Worst-case USD of one answer on one model: every round at its input budget and the full output cap. */
export function worstCaseUsd(price: { inputPerMillion: number; outputPerMillion: number }, inputBudgets: readonly number[], outputTokenCap: number): number {
  const input = inputBudgets.reduce((n, t) => n + t, 0);
  const output = inputBudgets.length * outputTokenCap;
  return (input * price.inputPerMillion + output * price.outputPerMillion) / 1_000_000;
}
