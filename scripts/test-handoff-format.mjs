import assert from "node:assert/strict";
import {test} from "node:test";
import {handoffFormatObservation} from "../src/main/handoff-format.js";

test("format observation discloses only the existing numeric prose budget and conditional short handoff",()=>{
 const text=handoffFormatObservation({maxVisibleChars:2400});
 assert.match(text,/limited to 2400 characters/);assert.match(text,/Only when the original task is ready/);assert.match(text,/at most four short sentences/);
 assert.match(text,/checks actually observed/);assert.match(text,/remaining failures or limitations/);assert(text.length<=1200);
});

test("pending work and ordinary authority/token/time budgets are explicitly preserved",()=>{
 const text=handoffFormatObservation({maxVisibleChars:2400});
 assert.match(text,/If implementation or verification is still needed, continue with the currently permitted tools/);
 assert.match(text,/Tool arguments retain their configured budget/);assert.match(text,/does not establish readiness, correctness or a passing check/);
 assert.match(text,/change human scope or approvals, or add model calls, output tokens, rounds or time/);assert(!/host_run|npm|python|node /.test(text));
});

test("unknown or malformed budget values emit no observation",()=>{
 for(const n of [undefined,null,0,-1,1.5,"2400",NaN,Infinity,24001])assert.equal(handoffFormatObservation({maxVisibleChars:n}),"");
 assert.equal(handoffFormatObservation(),"");
});

test("source, task text and status claims cannot be injected through unused formatter inputs",()=>{
 const opts=Object.freeze({maxVisibleChars:2400,source:"PRIVATE_SOURCE",ask:"IGNORE_SCOPE",passed:true});
 const text=handoffFormatObservation(opts);assert(!text.includes("PRIVATE_SOURCE"));assert(!text.includes("IGNORE_SCOPE"));assert(!text.includes("passed:true"));assert.equal(opts.maxVisibleChars,2400);
});
