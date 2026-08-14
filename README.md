# Wire

A lightweight, realtime, room-based chat application built with Cloudflare Workers, Durable Objects, WebSockets, and Durable Object SQLite.

Wire is intentionally small: the frontend, Worker routing, realtime room logic, persistent message storage, room discovery, themes, and interactive particle background all live together without a frontend framework.

## ✦ What is Wire?

Wire is an anonymous realtime messenger focused on three things:

- simple room-based conversations
- a polished, compact interface
- a lightweight Cloudflare-native backend

There is no traditional account system. A user chooses a display name, enters a room, and starts chatting.

The interface is designed to feel more like a small desktop application than a generic web dashboard.

---

## Features

### 💬 Realtime messaging

Messages are transmitted through WebSockets and broadcast to everyone connected to the same room.

Wire supports:

- realtime message delivery
- persistent message history
- multiple rooms
- automatic room connections
- join and leave system messages
- anonymous display names
- keyboard-friendly message composition

Messages are stored server-side, so refreshing the page does not erase the conversation.

---

### 🗂️ Global rooms

Rooms are registered in a shared room directory.

When one user creates a room:

```text
User A
   │
   │ creates #programming
   ▼
Global room directory
   │
   ├── User B sees #programming
   ├── User C sees #programming
   └── User D sees #programming
```

This means rooms are not limited to the browser that created them.

Every client periodically synchronizes the room list so newly created rooms become visible to other users.

---

### 🏠 Multiple rooms

Users can keep several rooms available at once.

Each room can be:

- opened
- switched
- closed
- reopened
- remembered locally

The active room is persisted in the browser.

The previously opened rooms are also restored after returning to the application.

---

### 🧹 Message management

Every message has compact management controls:

```text
Copy
Reply
Delete
```

The controls are attached directly below each message instead of floating somewhere else in the interface.

Deleting is a real backend operation.

When a message is deleted:

```text
Client
  ↓
WebSocket delete request
  ↓
Durable Object
  ↓
SQLite DELETE
  ↓
broadcast deletion event
  ↓
all connected users remove the message
```

---

## 🔐 Anonymous message ownership

Wire uses a hybrid identity model.

Every browser receives a locally generated user ID:

```text
simpleChatUserId
```

The selected username is also stored locally:

```text
simpleChatUsername
```

A message belongs to its author when either of these matches:

```text
stored user_id == current user_id
```

or

```text
stored username == current username
```

This allows the same username to manage its previous messages from another device.

### Important security note

This is an anonymous identity system.

Because there is no password or authentication layer, another person can technically enter the same username and inherit that username's message-management permissions.

For a public production messenger, real authentication should replace username-based ownership.

---

## 🎨 Theme system

Wire includes several visual themes:

- Night
- Daylight
- Obsidian
- Paper
- Deep Ocean
- Pine
- Rosewood

Themes are built around CSS variables rather than independent component styles.

That means a theme can change the entire visual language of the interface without touching the application logic.

Changing a theme does not:

- reconnect rooms
- reload the page
- clear messages
- change the active room
- reset the WebSocket

---

## 📜 Paper theme

The Paper theme intentionally uses a different hierarchy from the normal light theme.

Instead of turning everything into one flat beige surface, it uses:

```text
warm parchment background
        ↓
light ivory chat sheet
        ↓
slightly darker paper messages
        ↓
olive / moss accents
```

This makes the chat surface feel more like a physical sheet of paper sitting on a warm desk.

---

## 🌌 Particle constellation

The large empty areas surrounding the central chat are filled with an animated particle network.

The particle system is intentionally slow and stable.

Each particle has:

- a stable movement direction
- very low velocity
- subtle pulse animation
- a soft glow
- theme-independent base colors

Nearby particles are connected with lines.

```text
        ●──────●
       / \\    / \\
      ●───●──●   ●
       \\  |   \\ /
        ●─┘    ●
```

The result is a constellation / graph-like background rather than random decorative dots.

### Pointer interaction

The mouse slightly influences nearby particles.

Particles close to the pointer:

- become slightly brighter
- grow slightly
- illuminate nearby connections

Clicking an empty area creates additional particles there.

The particle collection is capped internally so repeatedly clicking the background cannot create unlimited particle state.

Old particles are removed when the maximum count is reached.

---

## 🖱️ Custom cursor

On desktop, Wire replaces the normal pointer with a small custom cursor consisting of:

- a central dot
- a delayed outer ring
- a crosshair
- a subtle pointer trail

The center follows the pointer immediately.

The ring follows with easing:

```javascript
ringX += (mouseX - ringX) * 0.2;
ringY += (mouseY - ringY) * 0.2;
```

The cursor also reacts to clicks and changes appearance briefly.

Touch devices automatically use the normal pointer behavior instead.

---

## ✉️ Message composer

The composer is intentionally compact.

It supports:

```text
Enter       → send
Shift+Enter → new line
```

The textarea automatically grows while typing and stops at a controlled maximum height.

The send button uses a custom arrow treatment rather than a stock Telegram-style icon.

The button also responds to hover, press, and disabled states.

---

## 🇮🇷 Persian language support

Wire includes support for Persian text using the Vazirmatn font.

Persian messages are automatically detected.

When Persian text is present, Wire switches to:

- Vazirmatn
- RTL direction
- RTL alignment
- improved Persian line-height

Mixed English and Persian conversations are supported.

Example:

```text
Hello everyone
سلام دوستان
How are you?
حالتون چطوره؟
```

---

## 👤 Display names

Wire does not require registration.

On first use, the application asks for a display name.

The name is stored locally in the browser.

Users can change it later through Settings.

The profile area also shows the first character of the selected name.

---

## ⚙️ Settings

The Settings panel provides:

- dark/light mode
- theme selection
- display-name management

The settings panel is designed as a compact side sheet rather than a full page.

---

## 🗃️ Room list

The room list is designed around a compact room-table layout.

Each room displays:

- room name
- availability / connection state
- active-room indicator
- close control for locally opened rooms

There is also a dedicated:

```text
+ New room
```

control.

The room list itself can be closed.

On desktop:

```text
Room list
    ↓
collapsed
    ↓
☰ button
```

Clicking the button opens the room list again.

On mobile, the room list behaves as a slide-out panel.

---

# Architecture

Wire uses Cloudflare's stateful edge architecture.

```text
                   Browser
                      │
              HTTP / WebSocket
                      │
                      ▼
             Cloudflare Worker
                      │
          ┌───────────┴───────────┐
          │                       │
          ▼                       ▼
   Room Directory            Chat Room DO
                                  │
                                  ▼
                          Durable Object SQLite
```

## Worker

The main Worker handles:

- HTTP routing
- room discovery API
- WebSocket routing
- HTML delivery

---

## Durable Objects

Each chat room maps to a Durable Object.

Conceptually:

```text
#general
    ↓
ChatRoom("general")

#programming
    ↓
ChatRoom("programming")

#gaming
    ↓
ChatRoom("gaming")
```

This keeps realtime connections and room state isolated by room.

---

## Durable Object SQLite

Messages are stored using Durable Object SQLite.

The main schema is:

```sql
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  username TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
)
```

The room directory stores globally registered rooms:

```sql
CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
)
```

---

# WebSocket flow

When a browser joins a room:

```text
Browser
  │
  │ WebSocket
  ▼
Worker
  │
  ▼
ChatRoom Durable Object
  │
  ├── accept socket
  ├── restore history
  └── broadcast join event
```

When a message is sent:

```text
Browser
  │
  │ { type: "message", text: "..." }
  ▼
Durable Object
  │
  ├── validate
  ├── write SQLite
  └── broadcast
       │
       ├── Client A
       ├── Client B
       └── Client C
```

---

# Validation

Both sides validate user input.

## Username

Maximum:

```text
32 characters
```

## Room name

Allowed:

```text
a-z
0-9
_
-
```

Maximum:

```text
64 characters
```

## Message

Maximum:

```text
2000 characters
```

The server validates the data again before writing it to storage.

Client-side validation should never be treated as the security boundary.

---

# Local storage

Wire uses browser `localStorage` for UI state.

Stored values include:

```text
simpleChatUserId
simpleChatUsername
simpleChatOpenRooms
simpleChatActiveRoom
simpleChatTheme
simpleChatMode
```

No passwords are stored because the application does not currently have password authentication.

---

# Project structure

The project can remain extremely small.

```text
wire-chat/
│
├── worker.js
├── wrangler.toml
├── README.md
└── LICENSE
```

Depending on your Wrangler setup, the main source file may instead be:

```text
src/index.js
```

The important concept is that the Worker, Durable Object, frontend HTML, CSS, and JavaScript can all live together.

---

# Requirements

You need:

- a Cloudflare account
- Node.js
- Wrangler
- a Worker project configured for Durable Objects

---

# Local development

Install Wrangler:

```bash
npm install -g wrangler
```

Log in:

```bash
wrangler login
```

Clone the repository:

```bash
git clone https://github.com/hosseinb1111/wire-chat.git
cd wire-chat
```

Start development:

```bash
npx wrangler dev
```

Wrangler will provide a local URL.

Open that URL in your browser.

---

# Deployment

A typical Wrangler configuration looks like:

```toml
name = "wire-chat"
main = "worker.js"

compatibility_date = "2026-01-01"

[[durable_objects.bindings]]
name = "CHAT_ROOM"
class_name = "ChatRoom"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["ChatRoom"]
```

Deploy using:

```bash
npx wrangler deploy
```

After deployment, Cloudflare hosts:

- the Worker
- the Durable Object infrastructure
- the room state
- the SQLite storage

---

# Performance

Wire intentionally avoids a large frontend stack.

There is no:

- React
- Vue
- Angular
- Bootstrap
- Tailwind
- frontend component library

The interface is plain HTML, CSS, and JavaScript.

The particle system is also intentionally bounded:

```text
maximum particles: 300
```

When the limit is reached, older particles are removed instead of continuously growing memory usage.

The network uses canvas rather than creating hundreds of DOM nodes.

---

# Responsive behavior

The layout changes depending on screen size.

### Desktop

```text
┌──────────┬──────────────────────────────┐
│          │                              │
│  rooms   │        conversation          │
│          │                              │
│          │                              │
└──────────┴──────────────────────────────┘
```

### Mobile

```text
┌──────────────────────────┐
│ ☰   #general        ⚙   │
│                          │
│       messages           │
│                          │
│                          │
│ ┌──────────────────────┐ │
│ │ message           → │ │
│ └──────────────────────┘ │
└──────────────────────────┘
```

The room list becomes a slide-out drawer instead of permanently consuming screen space.

---

# Privacy

Wire is anonymous by design in its current form.

There is no traditional:

```text
email
password
account
```

system.

The application uses:

- locally generated user IDs
- locally stored display names
- server-side message storage
- Durable Object state

Because there is no authentication, anonymous identity should not be considered a strong security boundary.

---

# Limitations

Wire is intentionally simple, which also means there are limitations.

Currently it does not provide:

- account authentication
- password-based ownership
- end-to-end encryption
- file uploads
- image messages
- message editing
- reactions
- typing indicators
- moderation tools
- role-based permissions
- read receipts
- push notifications

These are natural areas for future development.

---

# Possible roadmap

```text
[ ] Authentication
[ ] User accounts
[ ] Secure ownership
[ ] Message editing
[ ] Reactions
[ ] Typing indicators
[ ] Online member list
[ ] File uploads
[ ] Image messages
[ ] Message search
[ ] Notifications
[ ] Moderation
[ ] Room descriptions
[ ] Message encryption
```

The existing room-based Durable Object architecture provides a good base for adding these features.

---

# Design philosophy

Wire deliberately avoids looking like a generic administration dashboard.

The interface focuses on:

- compact controls
- restrained typography
- tactile buttons
- small room cards
- contained message bubbles
- clear surface hierarchy
- subtle shadows
- accent-driven states
- atmospheric backgrounds

The particle system adds movement without turning the conversation into a visual distraction.

The different themes intentionally change more than a single accent color.

---

# Why Cloudflare Durable Objects?

A traditional realtime application might look like:

```text
Frontend
   ↓
API server
   ↓
WebSocket server
   ↓
Redis
   ↓
Database
```

Wire can reduce that architecture to:

```text
Browser
   ↓
Cloudflare Worker
   ↓
Durable Object
   ↓
SQLite
```

That makes room-level realtime state much easier to reason about.

Each room becomes a natural unit of state.

---

# License

MIT License.

See `LICENSE` for the complete license text.

---

# Credits

Built with:

- Cloudflare Workers
- Cloudflare Durable Objects
- Durable Object SQLite
- WebSockets
- JavaScript
- HTML
- CSS
- Vazirmatn

---

# Final

Wire is intentionally not trying to be Discord, Telegram, or Slack.

It is a smaller idea:

**open a room, choose a name, and talk.**

One Worker.

Realtime WebSockets.

Stateful Durable Objects.

Persistent SQLite.

A small frontend.

And a little constellation in the background.
