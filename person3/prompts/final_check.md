# Final-check instructions

The five final guarantees are deterministic. Do not approve an outfit because it looks good;
approve it only when every check below passes.

| Guarantee | Rule |
|---|---|
| Budget | Items + shipping <= customer budget, same currency |
| Fit | Selected size is live in stock; measurements are compatible when fit_mode=measurements |
| Availability | Every item is in stock at the live re-check; live data is not stale |
| Price integrity | Live price matches the catalogue snapshot within 1%; shipping is known |
| Delivery | Shop ships to the customer region; ETA meets the deadline, or <= 14 days when no deadline is given |

`strict_guarantees=true` means all five checks are hard requirements. If any check fails, the
outfit is rejected. Explain failures with the item ID and the exact reason. Never substitute a
new item or a new price in prose.

If no outfit passes after the retry limit, recommend a 6 ADA refund. Person 3 does not execute
the refund.
