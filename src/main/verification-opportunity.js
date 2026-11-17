import {isAbsolute,resolve} from "node:path";
import {TURN_ROUND_CEILING} from "./turn-policy.js";
import {scratchRunRecoveryTool} from "./scratch-draft-budget.js";

export const VERIFICATION_OPPORTUNITY_ROUNDS = 2;
export const MIN_VERIFICATION_OPPORTUNITY_MS = 30_000;

/** A scheduling allowance, never progress, proof, a command or new authority.
 * This intentionally requires NO prior model host_run at all. A discovery or
 * version command also disables it; unknown verification intent is not guessed.
 */
export function createVerificationOpportunity({cwd,ask}={}) {
  // Optional scheduling must never turn an explicit no-execution instruction
  // into a command request. Overdecline ambiguous/quoted negatives here;
  // ordinary intent, permissions and approvals are unchanged.
  const executionRestricted = typeof ask !== "string" || !ask.trim()
    || /\b(?:do\s+not|don['’]t|never|without|avoid|stop|pause|cease)\s+(?:run(?:ning)?|execut(?:e|ing)|test(?:ing)?|verify(?:ing)?|check(?:ing)?|invok(?:e|ing))\b/i.test(ask)
    || /\b(?:do\s+not|don['’]t|never)\s+use\s+(?:host_run|shell|terminal|commands?)\b/i.test(ask)
    || /\bno\s+(?:commands?|execution|tests?|testing|runtime\s+checks?)\b/i.test(ask);
  let used=false,disabled=false,active=null;
  const context=(options, admission=false)=>{
    try {
      if(disabled || executionRestricted || options?.local!==true || options.editTask!==true || options.suspended!==false
        || options.busy!==false || options.signal?.aborted || typeof cwd!=="string" || !isAbsolute(cwd)
        || options.cwd!==cwd || !(options.permittedNames instanceof Set)
        || !Set.prototype.has.call(options.permittedNames,"host_run") || !Array.isArray(options.offered)) return null;
      const clock=options.clock;
      if(clock?.enabled!==true || clock.known!==true || !["work","verification"].includes(clock.phase)
        || !Number.isFinite(clock.remainingMs) || !Number.isFinite(clock.handoffMs) || clock.handoffMs<0
        || (admission ? clock.remainingMs-clock.handoffMs<MIN_VERIFICATION_OPPORTUNITY_MS : clock.remainingMs-clock.handoffMs<=0)) return null;
      const tool=scratchRunRecoveryTool(options.offered,options.toolChoice);
      if(!tool)return null;
      const observed=typeof options.observations==="function"?options.observations():options.observations;
      if(observed?.requestedSourceProgress!==true || observed.modelRunAttempted!==false
        || !Array.isArray(observed.actionDebt) || observed.actionDebt.length) return null;
      return {tool,cwd:resolve(cwd)};
    } catch{return null;}
  };
  return {
    get used(){return used;},
    disable(){disabled=true;active=null;},
    choose(options={}){
      if(used || !Number.isInteger(options.round) || !Number.isInteger(options.limit)
        || options.round<1 || options.limit<1 || options.round!==options.limit
        || options.limit+VERIFICATION_OPPORTUNITY_ROUNDS>TURN_ROUND_CEILING)return null;
      const selected=context(options,true);if(!selected)return null;
      used=true;active=Object.freeze({...selected,limitBefore:options.limit,limitAfter:options.limit+VERIFICATION_OPPORTUNITY_ROUNDS});return active;
    },
    current(choice,options={}){
      if(!choice || choice!==active)return false;
      const selected=context(options);return Boolean(selected && selected.tool===choice.tool && selected.cwd===choice.cwd);
    },
    finish(choice){if(choice===active)active=null;},
  };
}
