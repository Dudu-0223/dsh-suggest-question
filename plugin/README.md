# @dudu-0223/dsh-suggest-question

When a Turn ends, this bundle makes one auxiliary model request that guesses the
user's next message, draws the guess as a light ghost line inside the empty
composer, and fills it into the draft on **Tab**. The guess hides while the
draft is non-empty and returns when the draft is cleared.

- `index.js` — Host half: `POST /suggest-question/predict` (plus
  `POST /suggest-question/ping` and `GET /suggest-question/stats` diagnostics).
- `client.js` — Client half: `conversation.input.overlay` entry.
- `cordis.patch.yml` — inserts the `suggest-question` row.

See the repository README for installation and the repository
`market/index.json` for the plugin-market entry.
