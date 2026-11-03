// This file is written only into a fresh request's CODEX_HOME. User input is a
// TOML string value, never a key/table/override and never an exec argument.
export function codexCliInstructionConfig(instructions) {
  // JSON and TOML basic strings share these escapes. DEL must additionally be
  // escaped for TOML. Invalid UTF-16 is rejected by request validation first.
  const literal = JSON.stringify(instructions || 'Respond to the supplied user input with text. Do not invoke tools.').replace(/\u007f/g, '\\u007f')
  return `developer_instructions = ${literal}\n`
}
