# Optional: full WHOOP data via totem (unofficial)

Some data isn't in WHOOP's official API: the **in-sleep HR curve**, the **live strap HR**, the **Journal**, the hypnogram and stress. The open-source **totem** MCP ([github.com/thebriangao/totem](https://github.com/thebriangao/totem), MIT) gets this data through WHOOP's **private iOS app API**. You sign in with your own WHOOP login, and the session is refreshed through AWS Cognito.

**Risks, in totem's own words:** "That isn't what Whoop's terms allow". It is reverse-engineered, "Whoop could break it at any time", and WHOOP may suspend API access or end the membership of accounts that use it. Use it only if you accept that risk. The official server in this package carries none of it.

## What totem adds for a sleep coach
- `whoop_sleep`: hypnogram, plus average and minimum HR during sleep.
- `whoop_live_hr`: the current strap HR when the strap is streaming. Read it at lights-out to get a pre-sleep HR.
- `whoop_journal`, `whoop_journal_catalog`, `whoop_behavior_impact`: the morning Journal answers and how each behavior has moved recovery and sleep.
- `whoop_recovery` (RHR, HRV, respiratory rate, SpO2, skin temperature) and `whoop_trend` (multi-week series).
- `totem-whoop_sleep_hr.patch` (this folder) adds a **`whoop_sleep_hr`** tool. It reads the same in-sleep HR curve and returns in-bed awake HR before sleep onset, **sleep-onset HR** (mean of the first 10 minutes), **lowest HR and when it happened** (with % of the way into the night), **average sleeping HR**, HR by stage, and first-half vs second-half HR. Times are rebuilt from the graph's clock labels, so they can be off by a few minutes. The curve starts when WHOOP detects sleep, so it does not include HR from before you got into bed.

## Apply the patch
```bash
git clone https://github.com/thebriangao/totem && cd totem
git checkout f9ac7f1        # the commit the patch was tested on (applies cleanly; 318/318 tests pass)
git apply ../totem-whoop_sleep_hr.patch
npm install && npx tsc
```
Then follow totem's README (`totem cloud` or `totem local`) to sign in and connect it. To stay safe, give the bot read tools only and leave totem's write tools unused.
