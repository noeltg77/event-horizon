// Original text written for localmax (no third-party content), mixing the kinds of writing
// people actually ask models for: explanation, dialogue, instructions, technical prose and code.
// Used for the quality check (KL divergence vs a reference) and the long-prompt benchmark.

export const CORPUS = `The Keeper's Year

Before electric lamps, a lighthouse keeper's day was measured in wicks and weather. In the morning the lens had to be cleaned, because a single smear of soot could cut the light by a third. Brass was polished not for vanity but because salt eats metal quickly, and a seized gear could stop the rotation that gave each tower its signature. Ships did not only need to see a light; they needed to know which light it was. A steady white beam, two flashes every ten seconds, a red sector over the reef: each pattern was a sentence in a language every navigator learned.

The work changed with the seasons. Spring meant painting, because the winter gales stripped the tower back to bare render. Summer brought supply boats, and with them news, letters, and sometimes a relief keeper who would stay a fortnight. Autumn was for stockpiling oil and repairing the store rooms before the long dark months. Winter was simply endurance. On some rock stations the keepers did not set foot on the mainland for three months at a time, and the logbooks from those years are full of short, careful entries about wind direction, visibility, and the number of hours the fog signal ran.

What the logbooks rarely mention is loneliness, although it must have been constant. The keepers seem to have preferred routine as a remedy. One wrote that he wound the clockwork at exactly the same minute every evening because "the light keeps better time than I do, and I would rather follow it than my own moods." Another kept a garden in wooden boxes on the gallery, and recorded each tomato as carefully as each storm.

Automation arrived slowly and then all at once. By the end of the last century nearly every light had been converted to run without a resident crew. The towers still stand, but the rhythm of human attention that kept them burning has gone. Visitors climb the spiral stairs now and look out over the same water, and it is easy to forget that for two hundred years someone had to be awake up there all night.

A conversation at the harbour office

"I need to change the delivery date for the generator parts," said Maya, setting her folder on the counter.
"Which order is it?" asked the clerk, without looking up from his screen.
"The one for the north pier. It was booked for Thursday, but the crane won't be free until Monday."
"Monday is a bank holiday."
"Then Tuesday. As early as possible, please. The engineers are only on site until noon."
The clerk typed for a while, frowned, and typed again. "Tuesday morning is full. I can do Tuesday at two, or Wednesday at eight."
Maya thought about it. "Wednesday at eight. And can you add a note that the parts need to be unloaded by the pier gate, not the main entrance? The last delivery went to the wrong side and it took two hours to move everything."
"I'll add it in capitals," he said, and for the first time he smiled.

How to make a simple vegetable soup

You will need one onion, two carrots, two sticks of celery, one large potato, a tin of chopped tomatoes, a litre of stock, olive oil, salt, pepper, and a handful of fresh parsley.

1. Chop the onion, carrots and celery into small, even pieces. Even sizes matter more than small sizes, because they cook at the same rate.
2. Warm two tablespoons of olive oil in a large pan over a medium heat. Add the chopped vegetables with a pinch of salt and cook gently for ten minutes, stirring now and then, until the onion is soft but not brown.
3. Peel the potato, cut it into cubes, and add it to the pan with the tomatoes and the stock.
4. Bring the soup to a simmer, cover, and cook for twenty minutes, or until the potato breaks apart when pressed with a spoon.
5. Taste, then season with salt and pepper. If the soup is too thick, add a splash of hot water.
6. Stir in the chopped parsley just before serving.

The soup keeps for three days in the fridge and freezes well. Many people find it tastes better the next day, once the flavours have had time to settle.

Why networks retransmit

When two computers talk over the internet, the messages travel as small packets, and not every packet arrives. Routers drop packets when their queues are full, radio links lose them to interference, and occasionally a packet is corrupted on the way and discarded by the receiver. Reliable protocols therefore need a way to notice what went missing and send it again.

The usual approach is acknowledgement. The receiver tells the sender which data has arrived, and the sender keeps a copy of everything that has not yet been acknowledged. If an acknowledgement does not come back within a certain time, the sender assumes the data was lost and retransmits it. The difficult part is choosing that time. If it is too short, the sender floods the network with duplicates that were never lost, only delayed. If it is too long, a single lost packet stalls the whole conversation.

Modern implementations estimate the round-trip time continuously and set the timeout a little above the typical value, with a margin that grows when the measurements become noisy. They also use a faster signal: if the receiver keeps acknowledging the same point while later packets arrive, a gap is very likely, and the missing packet can be resent immediately rather than waiting for the timer. Together these two mechanisms keep transfers moving even on links that lose a few percent of their packets.

Congestion control sits on top of this. Losing packets is often a sign that the network is overloaded, so a well-behaved sender slows down when it detects loss and speeds up gradually when everything is delivered. That politeness is the reason the internet keeps working when millions of people start a download at the same moment.

A small program

The function below groups a list of transactions by category and returns the totals, rounded to two decimal places. It ignores rows with a missing amount instead of failing, and it reports how many it skipped.

def totals_by_category(rows):
    totals = {}
    skipped = 0
    for row in rows:
        amount = row.get("amount")
        if amount is None or amount == "":
            skipped += 1
            continue
        category = row.get("category", "uncategorised").strip().lower()
        totals[category] = totals.get(category, 0.0) + float(amount)
    rounded = {name: round(value, 2) for name, value in totals.items()}
    return rounded, skipped

if __name__ == "__main__":
    sample = [
        {"category": "Food", "amount": "12.50"},
        {"category": "food", "amount": "7.25"},
        {"category": "Travel", "amount": "40"},
        {"category": "Travel", "amount": ""},
    ]
    result, missing = totals_by_category(sample)
    print(result, "skipped:", missing)

A version in TypeScript looks much the same, although it is worth giving the rows a type so that a misspelled field is caught before the code runs:

type Row = { category?: string; amount?: string };

export function totalsByCategory(rows: Row[]): { totals: Record<string, number>; skipped: number } {
  const totals: Record<string, number> = {};
  let skipped = 0;
  for (const row of rows) {
    if (!row.amount) {
      skipped++;
      continue;
    }
    const key = (row.category ?? "uncategorised").trim().toLowerCase();
    totals[key] = (totals[key] ?? 0) + Number(row.amount);
  }
  for (const key of Object.keys(totals)) totals[key] = Math.round(totals[key] * 100) / 100;
  return { totals, skipped };
}

Advice for a first long walk

Plan a route you could shorten. The most common mistake is choosing a circular walk with no way to cut it short if the weather turns or your feet start to blister. A route that passes a bus stop or a village halfway round gives you an easy exit.

Break in your boots before the day. New boots that feel fine in the shop can rub badly after three hours. Wear them around the house and on short walks for a week first.

Carry more water than you think you need, and eat little and often rather than waiting for lunch. Tiredness on a long walk is often hunger in disguise.

Tell someone where you are going and when you expect to be back. It costs nothing and it matters enormously on the rare day that something goes wrong.

Finally, walk at a pace at which you could still hold a conversation. If you are too out of breath to talk, you are going too fast to last the whole day.

The repair shop

Arjun had fixed radios for thirty years, and in that time he had learned that most faults were not in the radios at all. People brought him sets that would not turn on, and he would hand them back with a new fuse and a gentle suggestion to check the plug. They brought him sets that crackled, and he would clean a switch that had not been moved in a decade. Only once or twice a week did something truly interesting arrive: a valve set from before the war, a portable that had been dropped in a river, a handmade receiver with no diagram at all.

Those were the ones he kept until last. He would lay them out on the bench under the good lamp, make a pot of tea, and trace the circuit with a pencil before he touched a single component. His daughter told him he should take photographs and put them online, because there were people who would pay to watch that kind of patience. He laughed and said that patience was the one thing you could not learn by watching. But that evening he set up the camera anyway, and the next morning, a little embarrassed, he asked her to show him how to upload the video.

Questions to ask before choosing a phone contract

How much data did you actually use in each of the last three months? Most people overestimate, and the difference between the middle tier and the top tier is often money spent on a buffer that never gets used.

Is the price fixed for the whole contract, or does it rise each year? Many contracts include an annual increase linked to inflation plus a few percent, which can add a surprising amount by the final year.

What happens when the minimum term ends? Some providers move you onto a higher rolling price automatically, so set a reminder a month before the end date.

Does the network have good coverage where you live and work, not just where you are standing in the shop? Coverage maps are a start, but asking neighbours is often more reliable.

A note on measurement

Every measurement has two kinds of error. The first is random: repeat the experiment and the number moves a little each time. The second is systematic: the method itself pushes every result in the same direction, and repeating the experiment does nothing to reveal it. Random error is easy to reduce by measuring several times and taking the middle value. Systematic error is harder, because it hides. The best defence is to measure the same thing in two different ways and see whether the answers agree. When they do not, the disagreement is information, and usually the most valuable information in the whole experiment.
`;

/** A long prompt for prefill benchmarks: the corpus repeated up to roughly `approxTokens`, then a question. */
export function longPrompt(approxTokens: number): string {
  // ~4 characters per token for English prose and code
  const targetChars = approxTokens * 4;
  let text = '';
  while (text.length < targetChars) text += CORPUS + '\n\n';
  return `${text.slice(0, targetChars)}\n\nIn one sentence, what is the main point of the section titled "A note on measurement"?`;
}
