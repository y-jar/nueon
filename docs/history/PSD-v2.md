
## Project Specification Document (PSD): Conlang Management & Translation Engine (v2)

> Implementation status: this is the original design brief. Most of it is
> shipped. The dynamic schema, hidden UUIDs, live-preview editor, dictionary
> search, misspelling guard, etymology and dependency handling, translation
> grid, inspector and packaging all exist. Tables and config are stored as
> plain extensionless JSON files (`dictionary/lex`, `config/translation`), as
> described here. The translation engine is clause-level, not sentence-level.

### 1. Data Structure & Schema Design

Instead of forcing a rigid linguistic structure, the application will use a highly dynamic schema.

* **Dynamic Data Model:** The only universally required field for any entry is the `wordname` (the base value). All other fields, tags, and categories (e.g., transitivity, gender, locational rules, formality) are entirely user-defined. Users create their own classification systems, and the application dynamically adapts its UI to these custom fields.
* **Homograph Handling (Identical Words):** To support multiple words with the exact same spelling or script, the underlying database will assign a hidden Unique Identifier (UUID) to every entry upon creation. To the user, the words appear identical in the list, but internally, the database treats them as distinct entities. Optionally, the UI can append a subtle index number (e.g., *word¹*, *word²*) in editor views to help the user distinguish them during bulk edits.
* **Extensionless File Storage:** Dictionary tables and config are saved locally as plain, extensionless files (e.g., `Roots` rather than `Roots.json`) within the user-designated workspace directory, keeping the file tree visually clean while remaining fully readable by the underlying Rust engine. Notes are Markdown files (`.md`).

### 2. Core Application Modules

#### A. Live-Preview Markdown Editor (The Notes View)

* **Obsidian-Style Rendering:** The editor functions as a single, unified view rather than a split-pane "code vs. preview" setup. Text is rendered as rich formatting (headers, bold, italics) natively on the screen.
* **Cursor Reveal Mechanic:** When the user clicks into or moves their cursor over a rendered element (like a header), that specific line seamlessly reverts to raw text, revealing the underlying Markdown syntax (e.g., `###`). Moving the cursor away instantly re-renders it.
* **Database Integration:** The editor can recognize and interact with words stored in the dictionary, potentially highlighting them or allowing hover-previews of their definitions.

#### B. The Dictionary Explorer & Database Menu

* **Dual-Layer Search System:**
* *Global Search:* Scans the entire dictionary database across all files and categories simultaneously.
* *Specific Search:* Allows the user to narrow the query to a specific user-defined tag, category, or field (e.g., searching only within words marked as "Favorite", or searching purely by "definition").


* **Dynamic Sorting:** Users can click to sort the database grid by `wordname` or by any of their custom-created categories and tags.
* **Misspelling Guard:** When a user is filling out the English definition fields, the app checks input against a standard dependency dictionary. If it detects a typo, it prompts a correction. This guard is strictly disabled for the conlang `wordname` fields.

#### C. Etymology & Derivation Engine

* **Dynamic Linking:** Users can assign a "Root/Parent" tag to a new word, permanently linking it to an existing base word in the database to track how words evolve or derive from one another.
* **Dependency Warning System:** If a user attempts to edit or delete a root word that other words depend on, the application intercepts the action and displays a warning detailing how many generated words are derived from it.
* **Resolution Options:** The interceptor provides four distinct choices:
1. *Cancel:* Aborts the edit entirely.
2. *Auto-Convert (Risky):* Automatically applies the spelling or structural change down the derivation tree to all child words.
3. *Manual Convert:* Opens a dedicated bulk-editor menu, listing every dependent word so the user can manually adjust each one sequentially.
4. *Continue Anyway:* Applies the change to the root word only. The child words remain visually unchanged but maintain their internal link to the newly edited parent word.



#### D. Visual Translation & Syntax Builder

* **The Translation Grid:** Instead of a simple text box, the translation menu opens with an empty, drag-and-drop grid representing a sentence structure.
* **Clause Construction:** The user drags their custom tags (e.g., "Subject", "Locational Noun", "Verb", "Particle") into the grid slots to define exactly how a sentence should be structured in their specific conlang. They can also define spaces for "between-word" rules.
* **Translation Execution:** Once the grid logic is set, the user inputs an English sentence. The app breaks the English sentence down, finds the conlang equivalents in the database, and maps them directly into the visual grid based on the user's dragged-and-dropped rules.
* **Conflict & Missing Word Handling:** If an English word has multiple distinct conlang translations (due to the homograph system), the app flags that grid slot, requiring the user to select the correct contextual meaning. If a word is missing entirely, it highlights the gap, allowing the user to immediately create a new database entry from the translation menu.

---------------------------------------------------------------------------------------------

## Looks

Here is a layout and navigation flow designed for efficiency, prioritizing a clean, native Linux feel with support for keyboard-centric navigation and tiling window environments.

## UI Layout & Architecture

The interface utilizes a modular, three-pane layout (Sidebar, Main Workspace, Inspector), allowing users to view their notes, database, and word relationships simultaneously without overlapping windows.

### 1. The Global Command & Search Bar (Top)

* **Omni-Search:** A unified search bar anchored at the top. Typing here triggers the dual-layer search:
* Typing normally executes a global text search across all notes and dictionary entries.
* Using a prefix (e.g., `tag:verb` or `def:run`) isolates the search to specific user-defined fields.


* **Quick Actions:** Keyboard shortcuts (e.g., `Ctrl+K`) focus this bar to quickly jump between files, add a new word, or launch the translation engine.

### 2. The Left Navigation Sidebar (Collapsible)

* **Workspace Tree:** Displays the user's Markdown note files organized by folders (e.g., `Grammar/`, `Culture/`).
* **Dictionary Categories:** A dynamic list populated by the user's custom categories (Nouns, Verbs, Particles). Clicking one opens that specific database grid in the Main Workspace.
* **Translation Presets:** Saved drag-and-drop syntax grids (e.g., "Standard SVO", "Question Form") for quick access.

### 3. The Main Workspace (Tabbed Center Pane)

This is the core working area. It supports a tabbed interface so users can quickly switch between editing a note and checking the dictionary.

* **When viewing Notes:** The pane becomes the Obsidian-style unified editor. It is clean and distraction-free, with the markdown syntax revealing itself only under the active cursor.
* **When viewing the Dictionary:** The pane transforms into a data grid (similar to a spreadsheet). Columns represent user-defined tags. Users can right-click column headers to sort, hide, or filter.
* **When viewing the Translation Engine:** The pane splits horizontally.
* *Top Half (The Builder):* The empty grid where users drag and drop their custom grammatical tags to form clause structures.
* *Bottom Half (The Execution):* A text input box for English, a dedicated output box for the conlang, and a conflict-resolution space if a word has multiple meanings.



### 4. The Context Inspector (Right Sidebar)

This pane dynamically changes based on what is selected in the Main Workspace.

* **Dictionary Context:** When a word is clicked in the database grid, this panel displays its full entry, allowing rapid editing without opening a separate window.
* **Etymology Visualizer:** If a word has a "Root/Parent" tag, this panel draws a visual tree showing the parent word and all other generated child words derived from it. This is where the user manages the "Dependency Warning" bulk-edits.
* **Notes Context:** When typing in the Notes editor, selecting a conlang word opens its definition and tags in this panel for quick reference.

## Navigation & Aesthetic Flow

* **Keyboard Navigation:** Built with Linux power-users in mind, every major pane and action is accessible via keyboard shortcuts, minimizing the need to drag the mouse back and forth.
* **Visual Theme:** To reduce eye strain during long documentation sessions, the default color palette can utilize warm, low-saturation earthy tones rather than harsh, high-contrast dark modes or blinding light modes.
* **Seamless Switching:** Clicking an unknown word in the Translation Engine instantly slides out the Right Inspector, pre-filled with the English word, allowing the user to assign it a conlang spelling, tag it, and save it directly into the database without leaving the translation screen.
