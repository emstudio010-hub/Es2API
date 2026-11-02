# Bundled ModelTrace detector

Source: https://github.com/haowang02/cpa-plugin-codex-candy-eval
Pinned CPA revision: `4f8367642cc1e629c4ee15a975e5e0fc53c4ac16`.
Algorithm source: https://github.com/Ikaleio/lm-detector
Pinned algorithm revision: `654c8334bb53951aaf04cbd61252d163649e1369`.

`cpa-v2/` is copied from the existing Sub2API-VM2 integration. MIT licenses,
original TypeScript, type-erased ESM, the binary data artifact, model descriptor,
enrollment challenges, golden evaluation cases and file hashes are retained.
Every manifest entry is verified when the integration starts. The descriptor is
also checked against the detector's model order and reference response counts.

On 2026-10-31, the pinned remote binary was verified byte-for-byte against this
copy. Remote model and challenge JSON were verified semantically equal; the
local files use different line endings. Current repository HEAD observed was
`179d6dae48a0f0a735637ea2f373345b91caaca8`; its detector/model files have changed.
This integration deliberately pins the already verified 60-candidate version.
Do not mix a new descriptor with an older detector. Update them together and
rerun golden parity checks before replacing this pin.

No CPA installer, host, native plugin or Codex hook is installed. Only the local
algorithm and data are used. `shared_detector.bin` is decoded numeric data,
not a native executable. The captured `codex_context.json` is retained as a
source artifact but is not sent or executed. Sampling preserves the account's
VM2 identity and uses each selected enrollment challenge's instructions and
user prompt. Results therefore depend on the VM2 environment and should not
be described as byte-for-byte reproduction of CPA's complete CLI context.

There are 36 challenges. A run selects 3 without replacement and makes exactly
one request per challenge, with no automatic retries. `gpt-6.1-sol` maps to
the `gpt-6-astra` candidate; these are one attribution class, not separately
identified models. The `deepseek-flash` alias also follows the pinned plugin.
Calibrated probabilities are relative to the closed set of listed candidates,
not an intelligence score or proof of the actual provider model.

Golden tests use historical outputs and make no supplier requests. Empty
production deployments load this bank without inserting synthetic accounts
or modifying an administrator's custom text reference bank.
