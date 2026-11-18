/** llama.cpp b11960 accepts string tool_choice only. Preserve named forcing by
 * restricting the exact existing schema and requiring that function. */
export function managedChatBody(body) {
  if (!body?.tool_choice || typeof body.tool_choice === "string") return body;
  const choice = body.tool_choice;
  if (choice.type !== "function" || typeof choice.function?.name !== "string" || !choice.function.name) throw Error("Invalid managed tool selection.");
  const definitions = (body.tools || []).filter(row => row?.type === "function" && row.function?.name === choice.function.name);
  if (definitions.length !== 1) throw Error("Managed tool selection has no unique declared schema.");
  return { ...body, tools: definitions, tool_choice: "required", parallel_tool_calls: false };
}
