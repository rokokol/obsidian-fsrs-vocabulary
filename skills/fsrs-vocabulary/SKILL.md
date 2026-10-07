---
name: fsrs-vocabulary
description: "Create and edit dictionaries of the FSRS Vocabulary plugin for Obsidian — markdown notes with a words table, spaced-repetition review, presets, custom columns, audio and image attachments, and embedded statistics. Use when the user asks to create a dictionary, add or import words, add a column, attach a pronunciation or a picture, embed dictionary stats in a note, or set up review presets. Triggers: dictionary note, vocabulary, add a word, add words to my dictionary, flashcards, spaced repetition, review preset, dictionary stats, словарь, добавь слово, добавь слова в словарь, заведи словарь, карточки, интервальные повторения, статистика словаря"
license: MIT
---

# FSRS Vocabulary

A dictionary is an ordinary markdown note. The plugin reads and writes the note itself, so you edit a dictionary through its markdown source with the ordinary file tools

## What makes a note a dictionary

The `fsrs-vocabulary` key at the root of the frontmatter. Its presence alone marks the note, whatever it holds; a new dictionary gets an empty mapping. A tag, a folder or a file name marks nothing, and a note without the key is silently not a dictionary

```markdown
---
fsrs-vocabulary: {}
---
Free markdown above the table is the theory section: rules, callouts, formulas, images

## Words

| word       | transcription  | translation | due | srs |
| ---------- | -------------- | ----------- | --- | --- |
| ubiquitous | /juːˈbɪkwɪtəs/ | everywhere  |     |     |
```

Other frontmatter properties are the note's own and the plugin leaves them alone

## The words table

- **The table follows a `Words` heading.** Any heading level, any letter case, but the word itself is `Words`: a heading in another language is not the marker. One per note, outside a code fence
- **One row is one word.** The first content column is the front of the card, the other content columns are its back, from left to right. Column names are free and there can be any number of them
- **`srs` and `due` belong to the plugin.** `srs` holds the review state, `due` the date of the next review. Write both lowercase: a column named `SRS` is an ordinary content column, and the next review adds a second schedule column beside it
- **A new word has `srs` and `due` empty.** The plugin reads an empty `srs` as a new card. Never write or change a value in either column: the review writes them
- **Fill every content cell.** When the dictionary opens in its view, the plugin fills a blank content cell with the name of its column and drops a row with no content at all. A cell left empty on purpose comes back as `translation`

To add words, append rows to the end of the table with the same columns as the header

## Attachments

Put an embed in a cell: `![[ubiquitous.mp3]]`, `![[cat.png]]`. It resolves like any Obsidian link, so the attachment can live anywhere in the vault. Audio plays and images show in the dictionary view and on the cards

## The config block

Everything the plugin stores about a dictionary lives under its `fsrs-vocabulary` key:

```yaml
fsrs-vocabulary:
  mute: true
  presets:
    - name: Reverse
      front: [translation]
      back: [word, transcription]
      pool: all
      order: shuffled
      record: false
```

- `mute: true` keeps the dictionary out of due counts and reminders
- `presets` are saved ways to review it. The first preset is what the quick review runs. `front` and `back` name content columns; an empty `back` means every column that is not on the front. `pool` is `due` or `all`, `order` is `file` or `shuffled`, and `record` says whether grades are written to `srs` and `due`

The review options in the app write this block. When you edit it by hand, keep the keys you do not know: the plugin carries them through

## Statistics in another note

A code block named `fsrs-vocabulary-stats` renders the review statistics:

`````markdown
```fsrs-vocabulary-stats
vault
```
`````

Each line of the body is one scope:

- an empty body: the current note, when it is a dictionary
- `vault` or `all`: every dictionary in the vault
- a dictionary name, a path or a `[[wiki-link]]`: that dictionary

`-muted` or `+muted` after a scope leaves muted dictionaries out of it or counts them in; on a line of its own, the flag applies to the whole block
