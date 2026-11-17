/** A formatting observation only, from the existing visible prose budget.
 * No source input, readiness verdict, tool command, permission or model budget.
 */
export function handoffFormatObservation({maxVisibleChars} = {}) {
  if (!Number.isInteger(maxVisibleChars) || maxVisibleChars < 1 || maxVisibleChars > 24_000) return "";
  return "<handoff_format_budget>\n"
    + `App-generated formatting observation: ordinary visible prose is limited to ${maxVisibleChars} characters on this response. `
    + "Only when the original task is ready for a handoff, use at most four short sentences: saved changes, checks actually observed, and remaining failures or limitations. Do not reprint source code or long check listings. "
    + "If implementation or verification is still needed, continue with the currently permitted tools instead of forcing a final answer. Tool arguments retain their configured budget. "
    + "This observation does not establish readiness, correctness or a passing check, change human scope or approvals, or add model calls, output tokens, rounds or time.\n"
    + "</handoff_format_budget>";
}
