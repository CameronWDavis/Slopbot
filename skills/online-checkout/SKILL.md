---
name: online-checkout
description: Use when buying an item in the shopping browser. Step-by-step checkout that works on most stores, and when to stop.
license: MIT
---

# Online checkout

1. `browser.read` the product page. Confirm the item name matches the task and note the price.
   If it says sold out, unavailable or "see price in cart", stop and report.
2. If there's a quantity field, make sure it's 1. Click **Add to cart** (not "Buy now" on the product page;
   SlopBot only allows the final order button on a page that shows the order total).
3. Go to the cart (a "Cart", "View cart" or "Checkout" button, or open the store's /cart page).
   `browser.read` it: exactly one line item, quantity 1, the right item. If other items are in the cart,
   stop and tell the user. Don't remove their items.
4. Click **Checkout** / **Proceed to checkout**. Pick "Continue" through shipping and payment steps,
   keeping the saved address, the cheapest standard shipping, and the saved payment method.
5. On the review page, find the order total. If it's within the limit, click the final button
   ("Place order", "Place your order", "Complete purchase", "Pay now").
6. `browser.read` the confirmation page and report the order number and total.

## Stop and report instead when

- You're asked to sign in, enter a password, card number, CVV or code, or prove you're not a robot.
- The total is over the limit, a warranty/protection plan or add-on was added, or the seller is a third party
  the task didn't mention.
- The page shows an error twice in a row.

Report exactly what you saw so the user can finish it themselves in the shopping browser.
