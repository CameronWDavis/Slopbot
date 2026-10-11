---
name: weekly-money-report
description: Use when writing a weekly (or any period) money report or spending summary. Defines the sections, order, length and tone.
license: MIT
---

# Weekly money report

Follow these steps in order. Every number must come from a finance tool result in this conversation.

1. Call `finance.summary` with `from` and `to` dates for the period (default: the last 7 days, ending today). If the user has budgets, they're in your memory.
2. Write the report with exactly these sections:

   **The headline**: one sentence with total spent, total income, and the net.

   **Where it went**: the top 3 spending categories, one line each: `Category: $amount (n transactions)`.
   Only real spending counts: leave out Transfers (money moved between your own accounts) and income.

   **Worth a look**: up to 3 bullets for anything unusual: a new subscription, a category well above
   last period, a single large transaction, or a budget that's over or close to it. Skip this section
   if nothing stands out. Don't invent concerns.

   **Still uncategorized**: only if there are uncategorized transactions; name the top merchants and suggest a rule.

3. Keep it under 150 words. Plain sentences, no emojis, no advice about investments.
4. If you're sending it (email or Telegram), use the subject `Your week in money: <start date> – <end date>`.

See `example.md` for what a good report looks like.
