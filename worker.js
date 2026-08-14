import { DurableObject } from "cloudflare:workers";

/* ============================================================
   CONFIG
   ============================================================ */

const MAX_USERNAME_LENGTH = 32;
const MAX_MESSAGE_LENGTH = 2000;
const HISTORY_LIMIT = 100;

const DIRECTORY_ID = "__wire_room_directory__";
const ROOM_SYNC_INTERVAL = 2500;


/* ============================================================
   HELPERS
   ============================================================ */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function cleanUsername(value) {
  const username = String(value ?? "").trim();

  if (!username) return null;
  if (username.length > MAX_USERNAME_LENGTH) return null;

  return username;
}

function cleanRoomId(value) {
  const room = String(value ?? "")
    .trim()
    .toLowerCase();

  if (!/^[a-z0-9_-]{1,64}$/.test(room)) {
    return null;
  }

  if (room === DIRECTORY_ID) {
    return null;
  }

  return room;
}

function cleanMessage(value) {
  const text = String(value ?? "").trim();

  if (!text) return null;
  if (text.length > MAX_MESSAGE_LENGTH) return null;

  return text;
}


/* ============================================================
   GLOBAL ROOM DIRECTORY
   ============================================================ */

async function getDirectory(env) {
  const id = env.CHAT_ROOM.idFromName(DIRECTORY_ID);
  return env.CHAT_ROOM.get(id);
}

async function registerRoomGlobally(env, roomId) {
  const clean = cleanRoomId(roomId);

  if (!clean) {
    return false;
  }

  const directory = await getDirectory(env);

  const response = await directory.fetch(
    new Request(
      "https://wire.internal/directory/register",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          roomId: clean,
        }),
      }
    )
  );

  return response.ok;
}

async function getGlobalRooms(env) {
  const directory = await getDirectory(env);

  return directory.fetch(
    new Request(
      "https://wire.internal/directory/list"
    )
  );
}


/* ============================================================
   WORKER
   ============================================================ */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return json({
        ok: true,
        service: "simple-chat",
        timestamp: Date.now(),
      });
    }

    /* --------------------------------------------------------
       GLOBAL ROOM API
       -------------------------------------------------------- */

    if (url.pathname === "/api/rooms") {
      if (request.method === "GET") {
        return getGlobalRooms(env);
      }

      if (request.method === "POST") {
        let body;

        try {
          body = await request.json();
        } catch {
          return json(
            {
              ok: false,
              error: "INVALID_JSON",
            },
            400
          );
        }

        const roomId = cleanRoomId(
          body?.roomId
        );

        if (!roomId) {
          return json(
            {
              ok: false,
              error: "INVALID_ROOM",
            },
            400
          );
        }

        try {
          const success =
            await registerRoomGlobally(
              env,
              roomId
            );

          if (!success) {
            return json(
              {
                ok: false,
                error:
                  "ROOM_REGISTRATION_FAILED",
              },
              500
            );
          }

          return json({
            ok: true,
            room: roomId,
          });
        } catch (error) {
          console.error(
            "GLOBAL_ROOM_REGISTER_FAILED:",
            error
          );

          return json(
            {
              ok: false,
              error:
                "ROOM_REGISTRATION_FAILED",
            },
            500
          );
        }
      }

      return new Response(
        "Method Not Allowed",
        {
          status: 405,
          headers: {
            Allow: "GET, POST",
          },
        }
      );
    }


    /* --------------------------------------------------------
       WEBSOCKET ROUTE
       -------------------------------------------------------- */

    const wsMatch =
      url.pathname.match(
        /^\/ws\/([a-zA-Z0-9_-]{1,64})$/
      );

    if (wsMatch) {
      if (
        request.headers
          .get("Upgrade")
          ?.toLowerCase() !==
        "websocket"
      ) {
        return new Response(
          "Expected WebSocket",
          {
            status: 426,
          }
        );
      }

      const roomId =
        cleanRoomId(
          wsMatch[1]
        );

      if (!roomId) {
        return json(
          {
            ok: false,
            error: "INVALID_ROOM",
          },
          400
        );
      }

      const username =
        cleanUsername(
          url.searchParams.get(
            "username"
          )
        );

      if (!username) {
        return json(
          {
            ok: false,
            error:
              "INVALID_USERNAME",
          },
          400
        );
      }

      let userId = String(
        url.searchParams.get(
          "userId"
        ) || ""
      ).trim();

      if (
        !userId ||
        userId.length > 100
      ) {
        userId =
          crypto.randomUUID();
      }

      try {
        await registerRoomGlobally(
          env,
          roomId
        );
      } catch (error) {
        console.error(
          "ROOM_AUTO_REGISTER_FAILED:",
          error
        );
      }

      const id =
        env.CHAT_ROOM.idFromName(
          roomId
        );

      const room =
        env.CHAT_ROOM.get(id);

      const doUrl =
        new URL(request.url);

      doUrl.pathname =
        "/websocket";

      doUrl.searchParams.set(
        "roomId",
        roomId
      );

      doUrl.searchParams.set(
        "username",
        username
      );

      doUrl.searchParams.set(
        "userId",
        userId
      );

      return room.fetch(
        new Request(
          doUrl.toString(),
          request
        )
      );
    }


    /* --------------------------------------------------------
       FRONTEND
       -------------------------------------------------------- */

    if (
      url.pathname === "/" ||
      url.pathname ===
        "/index.html"
    ) {
      return new Response(
        HTML,
        {
          headers: {
            "Content-Type":
              "text/html; charset=utf-8",
            "Cache-Control":
              "no-store",
          },
        }
      );
    }


    return new Response(
      "Not Found",
      {
        status: 404,
      }
    );
  },
};


/* ============================================================
   DURABLE OBJECT
   ============================================================ */

export class ChatRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);

    this.env = env;

    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        username TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);

    this.ctx.storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_created_at
      ON messages(created_at)
    `);

    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS rooms (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      )
    `);
  }


  async fetch(request) {
    const url =
      new URL(request.url);


    /* --------------------------------------------------------
       ROOM DIRECTORY: REGISTER
       -------------------------------------------------------- */

    if (
      url.pathname ===
      "/directory/register"
    ) {
      if (
        request.method !==
        "POST"
      ) {
        return new Response(
          "Method Not Allowed",
          {
            status: 405,
            headers: {
              Allow: "POST",
            },
          }
        );
      }

      let body;

      try {
        body =
          await request.json();
      } catch {
        return json(
          {
            ok: false,
            error:
              "INVALID_JSON",
          },
          400
        );
      }

      const roomId =
        cleanRoomId(
          body?.roomId
        );

      if (!roomId) {
        return json(
          {
            ok: false,
            error:
              "INVALID_ROOM",
          },
          400
        );
      }

      this.ctx.storage.sql.exec(
        `
        INSERT OR IGNORE INTO rooms (
          id,
          created_at
        )
        VALUES (?, ?)
        `,
        roomId,
        Date.now()
      );

      return json({
        ok: true,
        room: roomId,
      });
    }


    /* --------------------------------------------------------
       ROOM DIRECTORY: LIST
       -------------------------------------------------------- */

    if (
      url.pathname ===
      "/directory/list"
    ) {
      if (
        request.method !==
        "GET"
      ) {
        return new Response(
          "Method Not Allowed",
          {
            status: 405,
            headers: {
              Allow: "GET",
            },
          }
        );
      }

      this.ctx.storage.sql.exec(
        `
        INSERT OR IGNORE INTO rooms (
          id,
          created_at
        )
        VALUES (?, ?)
        `,
        "general",
        0
      );

      const rows =
        this.ctx.storage.sql
          .exec(
            `
            SELECT
              id,
              created_at
            FROM rooms
            ORDER BY
              CASE
                WHEN id = 'general' THEN 0
                ELSE 1
              END,
              created_at ASC,
              id ASC
            `
          )
          .toArray();

      return json({
        ok: true,
        rooms:
          rows.map(
            (row) => ({
              id: row.id,
              createdAt:
                row.created_at,
            })
          ),
      });
    }


    /* --------------------------------------------------------
       WEBSOCKET
       -------------------------------------------------------- */

    if (
      url.pathname !==
      "/websocket"
    ) {
      return new Response(
        "Not Found",
        {
          status: 404,
        }
      );
    }

    if (
      request.headers
        .get("Upgrade")
        ?.toLowerCase() !==
      "websocket"
    ) {
      return new Response(
        "Expected WebSocket",
        {
          status: 426,
        }
      );
    }

    const username =
      cleanUsername(
        url.searchParams.get(
          "username"
        )
      );

    if (!username) {
      return new Response(
        "Invalid username",
        {
          status: 400,
        }
      );
    }

    const userId =
      String(
        url.searchParams.get(
          "userId"
        ) || ""
      ).trim() ||
      crypto.randomUUID();

    const roomId =
      cleanRoomId(
        url.searchParams.get(
          "roomId"
        )
      ) ||
      "general";

    const pair =
      new WebSocketPair();

    const client =
      pair[0];

    const server =
      pair[1];

    this.ctx.acceptWebSocket(
      server
    );

    server.serializeAttachment(
      {
        userId,
        username,
        roomId,
        joinedAt: Date.now(),
      }
    );

    server.send(
      JSON.stringify({
        type:
          "connected",

        room:
          roomId,

        history:
          this.getHistory(),
      })
    );

    this.broadcast(
      {
        type:
          "system",

        event:
          "user_joined",

        userId,

        username,

        timestamp:
          Date.now(),
      },
      server
    );

    return new Response(
      null,
      {
        status: 101,
        webSocket: client,
      }
    );
  }


  /* ==========================================================
     WEBSOCKET MESSAGE
     ========================================================== */

  async webSocketMessage(
    ws,
    rawMessage
  ) {
    const session =
      ws.deserializeAttachment();

    if (!session) {
      this.safeSend(
        ws,
        {
          type:
            "error",

          code:
            "SESSION_NOT_FOUND",

          message:
            "Your session is no longer available.",
        }
      );

      return;
    }

    let payload;

    try {
      if (
        typeof rawMessage ===
        "string"
      ) {
        payload =
          JSON.parse(
            rawMessage
          );
      } else {
        payload =
          JSON.parse(
            new TextDecoder().decode(
              rawMessage
            )
          );
      }
    } catch {
      this.safeSend(
        ws,
        {
          type:
            "error",

          code:
            "INVALID_JSON",

          message:
            "Invalid JSON message.",
        }
      );

      return;
    }

    if (
      !payload ||
      typeof payload !==
        "object"
    ) {
      this.safeSend(
        ws,
        {
          type:
            "error",

          code:
            "INVALID_PAYLOAD",

          message:
            "Invalid message payload.",
        }
      );

      return;
    }


    /* --------------------------------------------------------
       SEND MESSAGE
       -------------------------------------------------------- */

    if (
      payload.type ===
      "message"
    ) {
      await this.handleChatMessage(
        ws,
        session,
        payload
      );

      return;
    }


    /* --------------------------------------------------------
       DELETE MESSAGE
       -------------------------------------------------------- */

    if (
      payload.type ===
      "delete"
    ) {
      await this.handleDeleteMessage(
        ws,
        session,
        payload
      );

      return;
    }


    /* --------------------------------------------------------
       PING
       -------------------------------------------------------- */

    if (
      payload.type ===
      "ping"
    ) {
      this.safeSend(
        ws,
        {
          type:
            "pong",

          timestamp:
            Date.now(),
        }
      );

      return;
    }


    this.safeSend(
      ws,
      {
        type:
          "error",

        code:
          "UNKNOWN_EVENT",

        message:
          "Unknown event type.",
      }
    );
  }


  /* ==========================================================
     CREATE MESSAGE
     ========================================================== */

  async handleChatMessage(
    ws,
    session,
    payload
  ) {
    const text =
      cleanMessage(
        payload.text
      );

    if (!text) {
      this.safeSend(
        ws,
        {
          type:
            "error",

          code:
            "INVALID_MESSAGE",

          message:
            "Message cannot be empty.",
        }
      );

      return;
    }

    const message = {
      id:
        crypto.randomUUID(),

      userId:
        session.userId,

      username:
        session.username,

      text,

      createdAt:
        Date.now(),
    };

    try {
      this.ctx.storage.sql.exec(
        `
        INSERT INTO messages (
          id,
          user_id,
          username,
          text,
          created_at
        )
        VALUES (?, ?, ?, ?, ?)
        `,
        message.id,
        message.userId,
        message.username,
        message.text,
        message.createdAt
      );
    } catch (error) {
      console.error(
        "MESSAGE_SAVE_FAILED:",
        error
      );

      this.safeSend(
        ws,
        {
          type:
            "error",

          code:
            "MESSAGE_SAVE_FAILED",

          message:
            "Could not save the message.",
        }
      );

      return;
    }

    this.broadcast(
      {
        type:
          "message",

        message,
      }
    );
  }


  /* ==========================================================
     DELETE MESSAGE

     IMPORTANT:
     Ownership is accepted when either:
       1. The generated userId matches
       2. The username matches

     This allows the same anonymous username on another
     device to manage its own previous messages.
     ========================================================== */

  async handleDeleteMessage(
    ws,
    session,
    payload
  ) {
    const messageId =
      String(
        payload?.messageId ||
          ""
      ).trim();

    if (
      !messageId ||
      messageId.length >
        100
    ) {
      this.safeSend(
        ws,
        {
          type:
            "error",

          code:
            "INVALID_MESSAGE_ID",

          message:
            "Invalid message ID.",
        }
      );

      return;
    }


    try {

      const existing =
        this.ctx.storage.sql
          .exec(
            `
            SELECT
              id,
              user_id,
              username
            FROM messages
            WHERE id = ?
            LIMIT 1
            `,
            messageId
          )
          .toArray();


      if (
        !existing.length
      ) {
        this.safeSend(
          ws,
          {
            type:
              "error",

            code:
              "MESSAGE_NOT_FOUND",

            message:
              "Message not found.",
          }
        );

        return;
      }


      const storedMessage =
        existing[0];


      /*
        A message can be deleted by
        the original generated identity
        OR by the same anonymous username.
      */

      const ownsMessage =
        storedMessage.user_id ===
          session.userId ||
        storedMessage.username ===
          session.username;


      if (!ownsMessage) {
        this.safeSend(
          ws,
          {
            type:
              "error",

            code:
              "DELETE_FORBIDDEN",

            message:
              "You can only delete your own messages.",
          }
        );

        return;
      }


      /*
        Delete using either identity.
      */

      this.ctx.storage.sql.exec(
        `
        DELETE FROM messages
        WHERE id = ?
          AND (
            user_id = ?
            OR username = ?
          )
        `,
        messageId,
        session.userId,
        session.username
      );


      this.broadcast(
        {
          type:
            "message_deleted",

          messageId,

          userId:
            session.userId,

          username:
            session.username,

          timestamp:
            Date.now(),
        }
      );

    } catch (error) {

      console.error(
        "MESSAGE_DELETE_FAILED:",
        error
      );

      this.safeSend(
        ws,
        {
          type:
            "error",

          code:
            "MESSAGE_DELETE_FAILED",

          message:
            "Could not delete the message.",
        }
      );
    }
  }


  /* ==========================================================
     HISTORY
     ========================================================== */

  getHistory() {

    const rows =
      this.ctx.storage.sql
        .exec(
          `
          SELECT
            id,
            user_id,
            username,
            text,
            created_at
          FROM messages
          ORDER BY created_at DESC
          LIMIT ?
          `,
          HISTORY_LIMIT
        )
        .toArray();

    rows.reverse();

    return rows.map(
      (row) => ({
        id:
          row.id,

        userId:
          row.user_id,

        username:
          row.username,

        text:
          row.text,

        createdAt:
          row.created_at,
      })
    );
  }


  /* ==========================================================
     BROADCAST
     ========================================================== */

  broadcast(
    payload,
    excludedSocket = null
  ) {
    const data =
      JSON.stringify(
        payload
      );

    for (
      const socket of
        this.ctx.getWebSockets()
    ) {
      if (
        socket ===
        excludedSocket
      ) {
        continue;
      }

      try {
        if (
          socket.readyState ===
          WebSocket.OPEN
        ) {
          socket.send(data);
        }
      } catch (error) {
        console.error(
          "BROADCAST_FAILED:",
          error
        );
      }
    }
  }


  /* ==========================================================
     SAFE SEND
     ========================================================== */

  safeSend(
    ws,
    payload
  ) {
    try {
      if (
        ws.readyState ===
        WebSocket.OPEN
      ) {
        ws.send(
          JSON.stringify(
            payload
          )
        );
      }
    } catch (error) {
      console.error(
        "SEND_FAILED:",
        error
      );
    }
  }


  /* ==========================================================
     WEBSOCKET CLOSE
     ========================================================== */

  async webSocketClose(
    ws,
    code,
    reason
  ) {
    const session =
      ws.deserializeAttachment();

    if (session) {
      this.broadcast({
        type:
          "system",

        event:
          "user_left",

        userId:
          session.userId,

        username:
          session.username,

        timestamp:
          Date.now(),
      });
    }

    try {
      ws.close(
        code,
        reason
      );
    } catch {
      // Ignore.
    }
  }


  /* ==========================================================
     WEBSOCKET ERROR
     ========================================================== */

  async webSocketError(
    ws,
    error
  ) {
    console.error(
      "WEBSOCKET_ERROR:",
      error
    );

    try {
      ws.close(
        1011,
        "WebSocket error"
      );
    } catch {
      // Ignore.
    }
  }
}


/* ============================================================
   FRONTEND
   ============================================================ */

const HTML = `
<!DOCTYPE html>
<html lang="en">
<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no"
>

<meta
  name="theme-color"
  content="#0a0a0a"
>

<title>Wire — quiet, realtime rooms</title>

<link
  rel="icon"
  href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='16' fill='%230b0c0a'/%3E%3Cpath d='M16 42V31h6v11h-6Zm13 0V24h6v18h-6Zm13 0V17h6v25h-6Z' fill='%238fb0a1'/%3E%3C/svg%3E"
>

<link
  rel="preconnect"
  href="https://fonts.googleapis.com"
>

<link
  rel="preconnect"
  href="https://fonts.gstatic.com"
  crossorigin
>

<link
  href="https://fonts.googleapis.com/css2?family=Vazirmatn:wght@400;500;600;700&display=swap"
  rel="stylesheet"
>

<style>

/* ============================================================
   1. ROOT
   ============================================================ */

:root {
  color-scheme: dark;

  --bg: #0a0a0a;
  --bg-deep: #070707;

  --sidebar: #12140f;
  --sidebar-hover: #191c16;
  --sidebar-active: #242a20;

  --surface: #151713;
  --surface-2: #191c17;
  --surface-3: #20241d;
  --surface-4: #282d24;

  --input: #10120f;

  --message: #1a1d18;
  --message-mine: #22372b;

  --text: #f0eee6;
  --text-soft: #cbc8bc;
  --muted: #88857a;
  --faint: #57554d;

  --accent: #93b0a2;
  --accent-hover: #a9c0b4;

  --network-sage: #93b0a2;
  --network-blue: #57b9c9;

  --accent-soft: rgba(147,176,162,.12);
  --accent-strong: rgba(147,176,162,.24);
  --accent-ink: #09130f;

  --danger: #d77b70;
  --danger-soft: rgba(215,123,112,.12);

  --border: rgba(239,237,228,.07);
  --border-strong: rgba(239,237,228,.15);

  --focus: rgba(147,176,162,.30);

  --chat-surface: rgba(21,23,19,.94);
  --header-surface: rgba(21,23,19,.78);

  --shadow: 0 22px 70px rgba(0,0,0,.34);
  --shadow-soft: 0 8px 24px rgba(0,0,0,.16);

  --sidebar-width: 252px;

  --chat-width:
    min(
      900px,
      calc(
        100vw -
        var(--sidebar-width) -
        64px
      )
    );

  --radius-sm: 8px;
  --radius: 11px;

  --font-ui:
    Inter,
    ui-sans-serif,
    system-ui,
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;

  --font-persian:
    "Vazirmatn",
    var(--font-ui);

  --font-display:
    Georgia,
    "Times New Roman",
    serif;

  --font-mono:
    "SFMono-Regular",
    Consolas,
    "Liberation Mono",
    Menlo,
    monospace;

  --ease:
    cubic-bezier(.2,.7,.25,1);
}


/* ============================================================
   2. DAYLIGHT
   ============================================================ */

[data-theme="light"] {
  color-scheme: light;

  --bg: #e8e7e1;
  --bg-deep: #deddd7;

  --sidebar: #f3f2ed;
  --sidebar-hover: #e9e8e2;
  --sidebar-active: #e0e5de;

  --surface: #f7f6f1;
  --surface-2: #fcfbf7;
  --surface-3: #efeee8;
  --surface-4: #e4e5df;

  --input: #efeee8;

  --message: #f0efe9;
  --message-mine: #dce9e1;

  --text: #272620;
  --text-soft: #555248;
  --muted: #817d71;
  --faint: #aaa69b;

  --accent: #557b6e;
  --accent-hover: #456a5c;

  --network-sage: #557b6e;
  --network-blue: #428f9e;

  --accent-soft: rgba(85,123,110,.11);
  --accent-strong: rgba(85,123,110,.20);
  --accent-ink: #f8fbf9;

  --danger: #b45b51;
  --danger-soft: rgba(180,91,81,.10);

  --border: rgba(38,37,31,.09);
  --border-strong: rgba(38,37,31,.16);

  --focus: rgba(85,123,110,.24);

  --chat-surface: rgba(247,246,241,.96);
  --header-surface: rgba(247,246,241,.84);

  --shadow:
    0 22px 65px rgba(49,46,36,.14);

  --shadow-soft:
    0 8px 24px rgba(49,46,36,.08);
}


/* ============================================================
   3. OBSIDIAN
   ============================================================ */

[data-theme="obsidian"] {
  --bg: #060707;
  --bg-deep: #030404;

  --sidebar: #0a0b0b;
  --sidebar-hover: #131515;
  --sidebar-active: #1d1f1f;

  --surface: #0d0f0f;
  --surface-2: #111313;
  --surface-3: #171919;
  --surface-4: #1e2020;

  --input: #0a0b0b;

  --message: #111313;
  --message-mine: #231c10;

  --text: #f3f1eb;
  --text-soft: #c6c3ba;
  --muted: #77746d;
  --faint: #484743;

  --accent: #c8a364;
  --accent-hover: #d7b477;

  --network-sage: #c8a364;
  --network-blue: #bb7f52;

  --accent-soft: rgba(200,163,100,.11);
  --accent-strong: rgba(200,163,100,.21);
  --accent-ink: #1c1305;

  --danger: #dc777f;
  --danger-soft: rgba(220,119,127,.10);

  --border: rgba(245,242,233,.05);
  --border-strong: rgba(245,242,233,.12);

  --focus: rgba(200,163,100,.28);
}


/* ============================================================
   4. PAPER
   ============================================================ */

[data-theme="paper"] {
  color-scheme: light;

  --bg: #d9d1c0;
  --bg-deep: #cfc6b4;

  --sidebar: #eee8da;
  --sidebar-hover: #e5dece;
  --sidebar-active: #d9e0d2;

  --surface: #f8f4ea;
  --surface-2: #fbf8f0;
  --surface-3: #eee8da;
  --surface-4: #e3dccd;

  --input: #f1ecdf;

  --message: #eee8da;
  --message-mine: #dfe6d6;

  --text: #2d2a22;
  --text-soft: #5c574b;
  --muted: #817a6b;
  --faint: #aaa293;

  --accent: #69794f;
  --accent-hover: #596941;

  --network-sage: #69794f;
  --network-blue: #789386;

  --accent-soft: rgba(105,121,79,.11);
  --accent-strong: rgba(105,121,79,.20);
  --accent-ink: #f8faf4;

  --danger: #aa584a;
  --danger-soft: rgba(170,88,74,.10);

  --border: rgba(63,57,43,.10);
  --border-strong: rgba(63,57,43,.17);

  --focus: rgba(105,121,79,.24);

  --chat-surface: rgba(248,244,234,.97);
  --header-surface: rgba(248,244,234,.88);

  --shadow:
    0 24px 70px rgba(88,76,51,.16);

  --shadow-soft:
    0 8px 24px rgba(88,76,51,.09);
}


/* ============================================================
   5. OCEAN
   ============================================================ */

[data-theme="ocean"] {
  --bg: #061016;
  --bg-deep: #030a0f;

  --sidebar: #09171e;
  --sidebar-hover: #102129;
  --sidebar-active: #14323a;

  --surface: #0b171e;
  --surface-2: #0f1e25;
  --surface-3: #12262e;
  --surface-4: #173039;

  --input: #09151b;

  --message: #10242c;
  --message-mine: #103a46;

  --text: #e8f5f8;
  --text-soft: #bdd5dc;
  --muted: #77939d;
  --faint: #47636d;

  --accent: #59bccb;
  --accent-hover: #6dcad7;

  --network-sage: #57b9c9;
  --network-blue: #77d3df;

  --accent-soft: rgba(89,188,203,.11);
  --accent-strong: rgba(89,188,203,.21);
  --accent-ink: #03171b;

  --danger: #e17d89;
  --danger-soft: rgba(225,125,137,.10);

  --border: rgba(200,232,240,.06);
  --border-strong: rgba(200,232,240,.13);

  --focus: rgba(89,188,203,.27);
}


/* ============================================================
   6. PINE
   ============================================================ */

[data-theme="pine"] {
  --bg: #080e0a;
  --bg-deep: #040806;

  --sidebar: #0f1912;
  --sidebar-hover: #18241b;
  --sidebar-active: #243629;

  --surface: #121b13;
  --surface-2: #18241a;
  --surface-3: #202d21;
  --surface-4: #29382b;

  --input: #0a130d;

  --message: #18241a;
  --message-mine: #233628;

  --text: #edf3e9;
  --text-soft: #c8d1c2;
  --muted: #829080;
  --faint: #526053;

  --accent: #8db180;
  --accent-hover: #a1c396;

  --network-sage: #8db180;
  --network-blue: #6fae91;

  --accent-soft: rgba(141,177,128,.11);
  --accent-strong: rgba(141,177,128,.21);
  --accent-ink: #09150b;

  --danger: #d4867b;
  --danger-soft: rgba(212,134,123,.10);

  --border: rgba(218,231,214,.065);
  --border-strong: rgba(218,231,214,.14);

  --focus: rgba(141,177,128,.28);
}


/* ============================================================
   7. ROSEWOOD
   ============================================================ */

[data-theme="rosewood"] {
  --bg: #12090d;
  --bg-deep: #070405;

  --sidebar: #190e13;
  --sidebar-hover: #2a181f;
  --sidebar-active: #3a222b;

  --surface: #1b1015;
  --surface-2: #25151b;
  --surface-3: #2e1b23;
  --surface-4: #3c242e;

  --input: #11090d;

  --message: #26161c;
  --message-mine: #3a232c;

  --text: #f7ebee;
  --text-soft: #d8c0c6;
  --muted: #a3878f;
  --faint: #654e57;

  --accent: #cf8e9d;
  --accent-hover: #df9eac;

  --network-sage: #cf8e9d;
  --network-blue: #b77590;

  --accent-soft: rgba(207,142,157,.11);
  --accent-strong: rgba(207,142,157,.22);
  --accent-ink: #241015;

  --danger: #e07b87;
  --danger-soft: rgba(224,123,135,.11);

  --border: rgba(249,223,231,.06);
  --border-strong: rgba(249,223,231,.13);

  --focus: rgba(207,142,157,.28);
}


/* ============================================================
   8. RESET
   ============================================================ */

* {
  box-sizing: border-box;
}

html,
body {
  width:
    100%;

  height:
    100%;

  margin:
    0;
}

body {
  overflow:
    hidden;

  background:
    var(--bg);

  color:
    var(--text);

  font-family:
    var(--font-ui);

  -webkit-font-smoothing:
    antialiased;

  text-rendering:
    optimizeLegibility;

  user-select:
    none;

  -webkit-user-select:
    none;

  -webkit-tap-highlight-color:
    transparent;

  cursor:
    none;
}

button,
input,
textarea {
  font:
    inherit;

  color:
    inherit;
}

button {
  border:
    0;
}

textarea,
input {
  cursor:
    text;
}

:focus-visible {
  outline:
    2px solid
    var(--accent);

  outline-offset:
    2px;
}

::selection {
  background:
    var(--accent);

  color:
    var(--accent-ink);
}


/* ============================================================
   9. PARTICLES
   ============================================================ */

#particleCanvas {
  position:
    fixed;

  inset:
    0;

  width:
    100vw;

  height:
    100vh;

  display:
    block;

  background:
    transparent;

  z-index:
    1;

  pointer-events:
    none;
}

.depth {
  position:
    fixed;

  inset:
    0;

  pointer-events:
    none;

  z-index:
    2;

  background:
    radial-gradient(
      circle at 50% 45%,
      color-mix(
        in srgb,
        var(--accent) 7%,
        transparent
      ),
      transparent 40%
    ),
    radial-gradient(
      circle at var(--mouse-x, 50%)
        var(--mouse-y, 50%),
      color-mix(
        in srgb,
        var(--network-blue) 3%,
        transparent
      ),
      transparent 25%
    ),
    radial-gradient(
      ellipse at center,
      transparent 30%,
      rgba(0,0,0,.20) 100%
    );
}


/* ============================================================
   10. CURSOR
   ============================================================ */

.cursor-dot {
  position:
    fixed;

  left:
    0;

  top:
    0;

  width:
    10px;

  height:
    10px;

  border-radius:
    50%;

  background:
    var(--accent);

  box-shadow:
    0
    0
    10px
    color-mix(
      in srgb,
      var(--accent) 80%,
      transparent
    );

  pointer-events:
    none;

  z-index:
    9999;

  transform:
    translate(
      -50%,
      -50%
    );

  opacity:
    0;
}

.cursor-ring {
  position:
    fixed;

  left:
    0;

  top:
    0;

  width:
    38px;

  height:
    38px;

  border:
    1px
    solid
    color-mix(
      in srgb,
      var(--accent) 65%,
      transparent
    );

  border-radius:
    50%;

  pointer-events:
    none;

  z-index:
    9998;

  transform:
    translate(
      -50%,
      -50%
    );

  opacity:
    0;

  transition:
    width .18s ease,
    height .18s ease,
    border-color .18s ease,
    opacity .2s ease;
}

.cursor-ring.active {
  width:
    28px;

  height:
    28px;

  border-color:
    var(--network-blue);
}

.cursor-cross {
  position:
    fixed;

  left:
    0;

  top:
    0;

  width:
    22px;

  height:
    22px;

  pointer-events:
    none;

  z-index:
    9997;

  transform:
    translate(
      -50%,
      -50%
    );

  opacity:
    0;
}

.cursor-cross::before,
.cursor-cross::after {
  content:
    "";

  position:
    absolute;

  background:
    color-mix(
      in srgb,
      var(--accent) 38%,
      transparent
    );
}

.cursor-cross::before {
  width:
    1px;

  height:
    22px;

  left:
    50%;

  top:
    50%;

  transform:
    translate(
      -50%,
      -50%
    );
}

.cursor-cross::after {
  width:
    22px;

  height:
    1px;

  left:
    50%;

  top:
    50%;

  transform:
    translate(
      -50%,
      -50%
    );
}

.cursor-trail {
  position:
    fixed;

  width:
    4px;

  height:
    4px;

  border-radius:
    50%;

  pointer-events:
    none;

  z-index:
    9996;

  transform:
    translate(
      -50%,
      -50%
    );

  background:
    color-mix(
      in srgb,
      var(--accent) 42%,
      transparent
    );

  box-shadow:
    0
    0
    8px
    color-mix(
      in srgb,
      var(--accent) 36%,
      transparent
    );
}

@media (
  hover: none
),
(
  pointer: coarse
) {
  body {
    cursor:
      default;
  }

  .cursor-dot,
  .cursor-ring,
  .cursor-cross,
  .cursor-trail {
    display:
      none;
  }
}


/* ============================================================
   11. APP
   ============================================================ */

.app {
  position:
    relative;

  z-index:
    3;

  width:
    100vw;

  height:
    100vh;

  display:
    flex;
}


/* ============================================================
   12. SIDEBAR
   ============================================================ */

.sidebar {
  position:
    relative;

  z-index:
    100;

  width:
    var(--sidebar-width);

  min-width:
    var(--sidebar-width);

  display:
    flex;

  flex-direction:
    column;

  background:
    linear-gradient(
      180deg,
      var(--sidebar),
      var(--bg)
    );

  border-right:
    1px
    solid
    var(--border);

  overflow:
    hidden;

  transition:
    width .22s var(--ease),
    min-width .22s var(--ease),
    border-color .22s var(--ease);
}


/*
  IMPORTANT:
  Explicit desktop collapsed state.
*/

body.room-list-hidden .sidebar {
  width:
    0 !important;

  min-width:
    0 !important;

  border-right:
    0 !important;

  overflow:
    hidden !important;

  pointer-events:
    none !important;
}

body.room-list-hidden .sidebar > * {
  visibility:
    hidden;
}


.sidebar-header {
  flex:
    0
    0
    auto;

  padding:
    16px
    14px
    13px;

  border-bottom:
    1px
    solid
    var(--border);
}

.brand {
  display:
    flex;

  align-items:
    center;

  gap:
    9px;
}

.brand-mark {
  width:
    35px;

  height:
    35px;

  flex:
    0
    0
    35px;

  display:
    flex;

  align-items:
    center;

  justify-content:
    center;

  border:
    1px
    solid
    var(--border-strong);

  border-radius:
    9px;

  background:
    var(--surface-2);

  color:
    var(--accent);

  font-family:
    var(--font-display);

  font-size:
    16px;

  font-weight:
    600;
}

.brand-text {
  min-width:
    0;
}

.brand-name {
  font-family:
    var(--font-display);

  font-size:
    15px;

  font-weight:
    600;
}

.brand-subtitle {
  margin-top:
    2px;

  color:
    var(--muted);

  font-family:
    var(--font-mono);

  font-size:
    7.5px;
}

.sidebar-actions {
  margin-top:
    11px;
}

.nav-button {
  width:
    100%;

  height:
    34px;

  display:
    flex;

  align-items:
    center;

  justify-content:
    center;

  gap:
    7px;

  padding:
    0
    9px;

  border:
    1px
    solid
    var(--border);

  border-radius:
    8px;

  background:
    var(--surface-3);

  color:
    var(--text-soft);

  cursor:
    pointer;

  font-size:
    10px;

  font-weight:
    650;

  transition:
    background .15s var(--ease),
    border-color .15s var(--ease),
    color .15s var(--ease),
    transform .15s var(--ease);
}

.nav-button:hover {
  background:
    var(--sidebar-hover);

  border-color:
    var(--border-strong);

  color:
    var(--text);

  transform:
    translateY(-1px);
}

.nav-glyph {
  font-size:
    15px;
}

.sidebar-content {
  flex:
    1;

  min-height:
    0;

  overflow-y:
    auto;

  padding:
    13px
    8px
    10px;

  scrollbar-width:
    thin;

  scrollbar-color:
    var(--border-strong)
    transparent;
}

.sidebar-heading {
  display:
    flex;

  align-items:
    center;

  justify-content:
    space-between;

  padding:
    0
    7px
    8px;

  color:
    var(--muted);

  font-family:
    var(--font-mono);

  font-size:
    7.5px;

  text-transform:
    uppercase;

  letter-spacing:
    .13em;
}

.sidebar-heading::after {
  content:
    "";

  width:
    4px;

  height:
    4px;

  border-radius:
    50%;

  background:
    var(--accent);
}

.chat-list {
  display:
    flex;

  flex-direction:
    column;

  gap:
    2px;
}

.chat-item {
  position:
    relative;

  width:
    100%;

  min-height:
    45px;

  display:
    flex;

  align-items:
    center;

  gap:
    8px;

  padding:
    5px
    5px
    5px
    9px;

  border:
    1px
    solid
    transparent;

  border-radius:
    9px;

  background:
    transparent;

  cursor:
    pointer;
}

.chat-item:hover {
  background:
    var(--sidebar-hover);

  border-color:
    var(--border);
}

.chat-item.active {
  background:
    var(--sidebar-active);

  border-color:
    var(--border);
}

.chat-item.active::before {
  content:
    "";

  position:
    absolute;

  left:
    0;

  top:
    8px;

  bottom:
    8px;

  width:
    2px;

  border-radius:
    999px;

  background:
    var(--accent);
}

.signal {
  width:
    29px;

  height:
    29px;

  flex:
    0
    0
    29px;

  display:
    flex;

  align-items:
    center;

  justify-content:
    center;

  gap:
    2px;

  border:
    1px
    solid
    var(--border);

  border-radius:
    8px;

  background:
    var(--surface-3);

  color:
    var(--muted);
}

.chat-item.active .signal {
  background:
    var(--accent-soft);

  border-color:
    var(--accent-strong);

  color:
    var(--accent);
}

.signal-bar {
  width:
    3px;

  border-radius:
    999px;

  background:
    currentColor;

  opacity:
    .6;
}

.signal-bar:nth-child(1) {
  height:
    6px;
}

.signal-bar:nth-child(2) {
  height:
    9px;
}

.signal-bar:nth-child(3) {
  height:
    12px;
}

.chat-item.is-connected
.signal-bar {
  animation:
    signalPulse
    2.7s
    ease-in-out
    infinite;
}

@keyframes signalPulse {
  0%,
  100% {
    transform:
      scaleY(1);
  }

  50% {
    transform:
      scaleY(.62);
  }
}

.chat-info {
  min-width:
    0;

  flex:
    1;
}

.chat-name {
  overflow:
    hidden;

  white-space:
    nowrap;

  text-overflow:
    ellipsis;

  color:
    var(--text);

  font-size:
    10.5px;

  font-weight:
    650;
}

.chat-status {
  margin-top:
    2px;

  color:
    var(--muted);

  font-family:
    var(--font-mono);

  font-size:
    7px;
}

.chat-item.available
.chat-status {
  color:
    var(--accent);
}

.chat-close {
  width:
    25px;

  height:
    25px;

  flex:
    0
    0
    25px;

  display:
    flex;

  align-items:
    center;

  justify-content:
    center;

  border:
    1px
    solid
    transparent;

  border-radius:
    7px;

  background:
    transparent;

  color:
    var(--muted);

  cursor:
    pointer;

  font-size:
    14px;

  opacity:
    .38;

  transition:
    opacity .12s ease,
    background .12s ease,
    color .12s ease;
}

.chat-item:hover
.chat-close,
.chat-close:focus-visible {
  opacity:
    1;
}

.chat-close:hover {
  background:
    var(--danger-soft);

  color:
    var(--danger);
}

.sidebar-footer {
  flex:
    0
    0
    auto;

  padding:
    9px;

  border-top:
    1px
    solid
    var(--border);
}

.sidebar-footer
.nav-button {
  margin-bottom:
    7px;
}

.user-card {
  width:
    100%;

  display:
    flex;

  align-items:
    center;

  gap:
    8px;

  padding:
    7px;

  border:
    1px
    solid
    var(--border);

  border-radius:
    9px;

  background:
    var(--surface-2);

  text-align:
    left;

  cursor:
    pointer;
}

.user-card:hover {
  background:
    var(--sidebar-hover);

  border-color:
    var(--border-strong);
}

.avatar {
  width:
    29px;

  height:
    29px;

  flex:
    0
    0
    29px;

  display:
    flex;

  align-items:
    center;

  justify-content:
    center;

  border:
    1px
    solid
    var(--accent-strong);

  border-radius:
    8px;

  background:
    var(--accent-soft);

  color:
    var(--accent);

  font-family:
    var(--font-display);

  font-size:
    12px;

  font-weight:
    600;
}

.user-meta {
  min-width:
    0;

  flex:
    1;
}

.user-name {
  overflow:
    hidden;

  white-space:
    nowrap;

  text-overflow:
    ellipsis;

  font-size:
    10px;

  font-weight:
    650;
}

.user-label {
  margin-top:
    2px;

  color:
    var(--muted);

  font-family:
    var(--font-mono);

  font-size:
    7px;
}


/* ============================================================
   13. MAIN
   ============================================================ */

.main {
  position:
    relative;

  z-index:
    10;

  min-width:
    0;

  flex:
    1;

  display:
    flex;

  flex-direction:
    column;
}

.main-header {
  position:
    relative;

  z-index:
    20;

  height:
    62px;

  flex:
    0
    0
    62px;

  display:
    flex;

  align-items:
    center;

  justify-content:
    space-between;

  gap:
    12px;

  padding:
    0
    18px;

  background:
    var(--header-surface);

  border-bottom:
    1px
    solid
    var(--border);

  backdrop-filter:
    blur(12px);
}

.room-title {
  min-width:
    0;

  display:
    flex;

  align-items:
    center;

  gap:
    9px;
}

.room-icon {
  width:
    32px;

  height:
    32px;

  flex:
    0
    0
    32px;

  display:
    flex;

  align-items:
    center;

  justify-content:
    center;

  border:
    1px
    solid
    var(--border);

  border-radius:
    9px;

  background:
    var(--surface-3);

  color:
    var(--muted);
}

.room-icon.live {
  background:
    var(--accent-soft);

  border-color:
    var(--accent-strong);

  color:
    var(--accent);
}

.room-name {
  overflow:
    hidden;

  white-space:
    nowrap;

  text-overflow:
    ellipsis;

  font-family:
    var(--font-display);

  font-size:
    15px;

  font-weight:
    600;
}

.room-state {
  margin-top:
    2px;

  color:
    var(--muted);

  font-family:
    var(--font-mono);

  font-size:
    7.5px;
}

.header-actions {
  display:
    flex;

  gap:
    5px;
}

.small-button {
  width:
    34px;

  height:
    34px;

  display:
    flex;

  align-items:
    center;

  justify-content:
    center;

  border:
    1px
    solid
    var(--border);

  border-radius:
    9px;

  background:
    var(--surface-2);

  color:
    var(--text-soft);

  cursor:
    pointer;
}

.small-button:hover {
  background:
    var(--surface-3);

  border-color:
    var(--border-strong);

  color:
    var(--text);

  transform:
    translateY(-1px);
}


/*
  Desktop: hidden by default.
  When the room list is closed, this becomes the
  button that brings it back.
*/

#sidebarToggle {
  display:
    none;
}

@media (min-width: 681px) {

  #sidebarToggle {
    position:
      fixed;

    left:
      10px;

    top:
      14px;

    z-index:
      150;

    opacity:
      0;

    pointer-events:
      none;
  }

  body.room-list-hidden
  #sidebarToggle {
    display:
      flex;

    opacity:
      1;

    pointer-events:
      auto;
  }
}


/* ============================================================
   14. CHAT
   ============================================================ */

.chat-stage {
  position:
    relative;

  z-index:
    10;

  flex:
    1;

  min-height:
    0;

  display:
    flex;

  align-items:
    center;

  justify-content:
    center;

  padding:
    18px
    22px;

  overflow:
    hidden;
}

.chat-surface {
  position:
    relative;

  z-index:
    12;

  width:
    var(--chat-width);

  max-width:
    900px;

  height:
    min(
      760px,
      calc(
        100vh -
        112px
      )
    );

  min-height:
    320px;

  display:
    flex;

  flex-direction:
    column;

  overflow:
    hidden;

  border:
    1px
    solid
    var(--border-strong);

  border-radius:
    17px;

  background:
    var(--chat-surface);

  box-shadow:
    var(--shadow);

  backdrop-filter:
    blur(16px);
}


/* ============================================================
   15. MESSAGES
   ============================================================ */

.messages {
  flex:
    1;

  min-height:
    0;

  overflow-y:
    auto;

  padding:
    24px
    28px
    16px;

  display:
    flex;

  flex-direction:
    column;

  gap:
    2px;

  scrollbar-width:
    thin;

  scrollbar-color:
    var(--border-strong)
    transparent;
}

.message {
  position:
    relative;

  width:
    fit-content;

  max-width:
    min(
      680px,
      78%
    );

  align-self:
    flex-start;

  margin-top:
    13px;

  animation:
    messageIn
    .18s
    var(--ease);
}

.message.mine {
  align-self:
    flex-end;
}

@keyframes messageIn {
  from {
    opacity:
      0;

    transform:
      translateY(4px);
  }

  to {
    opacity:
      1;

    transform:
      translateY(0);
  }
}

.message-head {
  width:
    fit-content;

  max-width:
    100%;

  display:
    flex;

  align-items:
    center;

  gap:
    7px;

  margin:
    0
    5px
    4px;
}

.message.mine
.message-head {
  margin-left:
    auto;

  justify-content:
    flex-end;
}

.message-user {
  font-size:
    9px;

  font-weight:
    700;
}

.message-time {
  color:
    var(--muted);

  font-family:
    var(--font-mono);

  font-size:
    7px;
}

.message-bubble {
  display:
    table;

  width:
    fit-content;

  max-width:
    100%;

  padding:
    9px
    11px;

  border:
    1px
    solid
    var(--border);

  border-radius:
    9px;

  background:
    var(--message);

  color:
    var(--text-soft);

  font-size:
    12px;

  line-height:
    1.58;

  white-space:
    pre-wrap;

  overflow-wrap:
    anywhere;

  word-break:
    break-word;
}

.message.mine
.message-bubble {
  margin-left:
    auto;

  background:
    var(--message-mine);

  border-color:
    var(--accent-strong);

  color:
    var(--text);
}

.message-actions {
  width:
    max-content;

  max-width:
    100%;

  display:
    flex;

  align-items:
    center;

  gap:
    3px;

  margin-top:
    5px;

  padding:
    3px
    2px
    0;

  border-top:
    1px
    solid
    var(--border);

  opacity:
    .82;
}

.message.mine
.message-actions {
  margin-left:
    auto;

  justify-content:
    flex-end;
}

.message-action {
  min-width:
    29px;

  height:
    26px;

  display:
    flex;

  align-items:
    center;

  justify-content:
    center;

  padding:
    0
    8px;

  border:
    1px
    solid
    transparent;

  border-radius:
    6px;

  background:
    transparent;

  color:
    var(--muted);

  cursor:
    pointer;

  font-size:
    8.5px;

  font-weight:
    650;
}

.message-action:hover {
  background:
    var(--surface-4);

  border-color:
    var(--border);

  color:
    var(--text);

  transform:
    translateY(-1px);
}

.message-action.copy:hover,
.message-action.reply:hover {
  color:
    var(--accent);
}

.message-action.delete:hover {
  background:
    var(--danger-soft);

  color:
    var(--danger);
}

.system-message {
  align-self:
    center;

  margin:
    8px
    0
    5px;

  padding:
    4px
    8px;

  border:
    1px
    solid
    var(--border);

  border-radius:
    999px;

  background:
    var(--surface-3);

  color:
    var(--muted);

  font-family:
    var(--font-mono);

  font-size:
    7px;
}

.empty-state {
  width:
    min(
      360px,
      100%
    );

  margin:
    auto;

  text-align:
    center;
}

.empty-symbol {
  width:
    46px;

  height:
    46px;

  margin:
    0
    auto
    12px;

  display:
    flex;

  align-items:
    center;

  justify-content:
    center;

  gap:
    3px;

  border:
    1px
    solid
    var(--border-strong);

  border-radius:
    13px;

  background:
    var(--surface-2);

  color:
    var(--accent);
}

.empty-symbol
.signal-bar {
  background:
    currentColor;

  opacity:
    .9;
}

.empty-title {
  font-family:
    var(--font-display);

  font-size:
    18px;

  font-weight:
    600;
}

.empty-description {
  max-width:
    260px;

  margin:
    5px
    auto
    0;

  color:
    var(--muted);

  font-size:
    9.5px;

  line-height:
    1.6;
}


/* ============================================================
   16. REPLY
   ============================================================ */

.reply-bar {
  width:
    100%;

  display:
    none;

  align-items:
    center;

  gap:
    8px;

  padding:
    7px
    10px;

  border-bottom:
    1px
    solid
    var(--border);

  background:
    var(--surface-2);
}

.reply-bar.open {
  display:
    flex;
}

.reply-indicator {
  width:
    3px;

  height:
    25px;

  flex:
    0
    0
    3px;

  border-radius:
    999px;

  background:
    var(--accent);
}

.reply-content {
  min-width:
    0;

  flex:
    1;
}

.reply-label {
  color:
    var(--accent);

  font-family:
    var(--font-mono);

  font-size:
    7px;

  text-transform:
    uppercase;
}

.reply-text {
  overflow:
    hidden;

  margin-top:
    2px;

  color:
    var(--muted);

  font-size:
    8px;

  white-space:
    nowrap;

  text-overflow:
    ellipsis;
}

.reply-cancel {
  width:
    25px;

  height:
    25px;

  display:
    flex;

  align-items:
    center;

  justify-content:
    center;

  border-radius:
    6px;

  background:
    transparent;

  color:
    var(--muted);

  cursor:
    pointer;

  font-size:
    15px;
}


/* ============================================================
   17. COMPOSER
   ============================================================ */

.composer {
  padding:
    9px
    15px
    12px;

  border-top:
    1px
    solid
    var(--border);

  background:
    var(--surface-2);
}

.composer-box {
  width:
    100%;

  display:
    flex;

  align-items:
    flex-end;

  gap:
    6px;

  padding:
    5px
    5px
    5px
    7px;

  border:
    1px
    solid
    var(--border-strong);

  border-radius:
    12px;

  background:
    var(--input);

  box-shadow:
    var(--shadow-soft);
}

.composer-box:focus-within {
  border-color:
    var(--accent);

  box-shadow:
    0
    0
    0
    3px
    var(--focus);
}

.message-input {
  flex:
    1;

  min-height:
    38px;

  max-height:
    160px;

  resize:
    none;

  overflow-y:
    auto;

  padding:
    8px;

  border:
    0;

  outline:
    0;

  background:
    transparent;

  color:
    var(--text);

  font-size:
    11.5px;

  line-height:
    1.55;

  user-select:
    text;
}

.message-input::placeholder {
  color:
    var(--muted);
}

.message-input:disabled {
  opacity:
    .5;
}


/* ============================================================
   18. SEND
   ============================================================ */

.send-button {
  width:
    42px;

  height:
    42px;

  position:
    relative;

  flex:
    0
    0
    42px;

  display:
    grid;

  place-items:
    center;

  padding:
    0;

  border:
    1px
    solid
    var(--accent-strong);

  border-radius:
    11px;

  background:
    var(--accent);

  color:
    var(--accent-ink);

  cursor:
    pointer;

  box-shadow:
    0
    5px
    15px
    rgba(0,0,0,.18);

  transition:
    transform .15s var(--ease),
    background .15s var(--ease),
    box-shadow .15s var(--ease);
}

.send-button:hover:not(:disabled) {
  background:
    var(--accent-hover);

  transform:
    translateY(-2px);

  box-shadow:
    0
    8px
    20px
    var(--accent-soft);
}

.send-button:active:not(:disabled) {
  transform:
    scale(.96);
}

.send-button:disabled {
  opacity:
    .28;

  box-shadow:
    none;

  cursor:
    not-allowed;
}

.send-arrow {
  position:
    relative;

  width:
    19px;

  height:
    15px;

  display:
    block;
}

.send-arrow-line {
  position:
    absolute;

  left:
    0;

  top:
    7px;

  width:
    14px;

  height:
    2px;

  border-radius:
    999px;

  background:
    currentColor;
}

.send-arrow-head {
  position:
    absolute;

  right:
    0;

  top:
    2px;

  width:
    10px;

  height:
    10px;

  border-top:
    2px
    solid
    currentColor;

  border-right:
    2px
    solid
    currentColor;

  transform:
    rotate(45deg);
}

.send-button:hover:not(:disabled)
.send-arrow-line {
  width:
    16px;
}

.send-button:hover:not(:disabled)
.send-arrow-head {
  transform:
    rotate(45deg)
    translate(
      1px,
      -1px
    );
}

.composer-hint {
  margin-top:
    4px;

  padding-left:
    3px;

  color:
    var(--faint);

  font-family:
    var(--font-mono);

  font-size:
    7px;
}


/* ============================================================
   19. PERSIAN
   ============================================================ */

.message-bubble.persian {
  font-family:
    var(--font-persian);

  line-height:
    1.9;

  direction:
    rtl;

  text-align:
    right;
}

.message-user.persian {
  font-family:
    var(--font-persian);

  direction:
    rtl;
}

.message-head.persian-head {
  direction:
    rtl;
}

.message-input.persian-input {
  font-family:
    var(--font-persian);

  line-height:
    1.9;
}


/* ============================================================
   20. SETTINGS
   ============================================================ */

.settings-overlay {
  position:
    fixed;

  inset:
    0;

  z-index:
    300;

  display:
    none;

  background:
    rgba(
      4,
      4,
      4,
      .56
    );

  backdrop-filter:
    blur(8px);
}

.settings-overlay.open {
  display:
    flex;
}

.settings-panel {
  width:
    min(
      430px,
      94vw
    );

  height:
    100%;

  margin-left:
    auto;

  padding:
    20px
    18px
    25px;

  overflow-y:
    auto;

  background:
    var(--surface);

  border-left:
    1px
    solid
    var(--border);

  box-shadow:
    var(--shadow);
}

.settings-header {
  display:
    flex;

  align-items:
    flex-start;

  justify-content:
    space-between;

  padding:
    0
    0
    15px;

  border-bottom:
    1px
    solid
    var(--border);
}

.settings-heading {
  font-family:
    var(--font-display);

  font-size:
    21px;

  font-weight:
    600;
}

.settings-subheading {
  margin-top:
    4px;

  color:
    var(--muted);

  font-family:
    var(--font-mono);

  font-size:
    7px;

  text-transform:
    uppercase;
}

.close-settings {
  width:
    32px;

  height:
    32px;

  display:
    flex;

  align-items:
    center;

  justify-content:
    center;

  border:
    1px
    solid
    var(--border);

  border-radius:
    9px;

  background:
    var(--surface-2);

  color:
    var(--text-soft);

  cursor:
    pointer;

  font-size:
    16px;
}

.close-settings:hover {
  background:
    var(--surface-3);

  border-color:
    var(--border-strong);

  color:
    var(--text);
}

.settings-section {
  margin-top:
    20px;
}

.settings-label {
  margin:
    0
    0
    8px
    2px;

  color:
    var(--muted);

  font-family:
    var(--font-mono);

  font-size:
    7px;

  text-transform:
    uppercase;

  letter-spacing:
    .14em;
}

.settings-card {
  padding:
    8px;

  border:
    1px
    solid
    var(--border);

  border-radius:
    11px;

  background:
    var(--surface-2);
}

.mode-grid,
.theme-grid {
  display:
    grid;

  grid-template-columns:
    repeat(
      2,
      minmax(
        0,
        1fr
      )
    );

  gap:
    6px;
}

.mode-button {
  min-height:
    70px;

  padding:
    10px;

  border:
    1px
    solid
    var(--border);

  border-radius:
    8px;

  background:
    var(--surface-3);

  color:
    var(--text);

  text-align:
    left;

  cursor:
    pointer;
}

.mode-button:hover {
  border-color:
    var(--border-strong);

  transform:
    translateY(-1px);
}

.mode-button.active {
  border-color:
    var(--accent);

  background:
    var(--accent-soft);
}

.mode-glyph {
  color:
    var(--muted);

  font-family:
    var(--font-mono);

  font-size:
    7px;
}

.mode-name {
  margin-top:
    8px;

  font-size:
    10.5px;

  font-weight:
    650;
}

.mode-description {
  margin-top:
    2px;

  color:
    var(--muted);

  font-size:
    8px;
}

.theme-card {
  position:
    relative;

  min-height:
    105px;

  padding:
    8px;

  border:
    1px
    solid
    var(--border);

  border-radius:
    9px;

  background:
    var(--surface-3);

  color:
    var(--text);

  cursor:
    pointer;

  text-align:
    left;
}

.theme-card:hover {
  border-color:
    var(--border-strong);

  transform:
    translateY(-1px);
}

.theme-card.active {
  border-color:
    var(--accent);

  background:
    var(--accent-soft);
}

.theme-card.active::after {
  content:
    "✓";

  position:
    absolute;

  top:
    7px;

  right:
    7px;

  width:
    17px;

  height:
    17px;

  display:
    flex;

  align-items:
    center;

  justify-content:
    center;

  border-radius:
    50%;

  background:
    var(--accent);

  color:
    var(--accent-ink);

  font-size:
    8px;

  font-weight:
    800;
}

.theme-preview {
  display:
    grid;

  grid-template-columns:
    24%
    1fr;

  gap:
    3px;

  height:
    39px;

  margin-bottom:
    8px;

  padding:
    3px;

  border-radius:
    5px;

  overflow:
    hidden;

  background:
    var(--input);
}

.preview-a {
  border-radius:
    3px;

  background:
    var(--surface-2);
}

.preview-b {
  position:
    relative;

  border-radius:
    3px;

  background:
    var(--surface-3);

  overflow:
    hidden;
}

.preview-b::before,
.preview-b::after {
  content:
    "";

  position:
    absolute;

  left:
    5px;

  border-radius:
    999px;

  background:
    var(--accent);
}

.preview-b::before {
  top:
    7px;

  width:
    36%;

  height:
    4px;

  opacity:
    .75;
}

.preview-b::after {
  top:
    16px;

  width:
    58%;

  height:
    3px;

  opacity:
    .28;
}

.theme-title {
  font-family:
    var(--font-display);

  font-size:
    10.5px;

  font-weight:
    600;
}

.theme-note {
  margin-top:
    2px;

  color:
    var(--muted);

  font-family:
    var(--font-mono);

  font-size:
    7px;
}

.profile-row {
  display:
    flex;

  align-items:
    center;

  gap:
    9px;
}

.profile-avatar {
  width:
    38px;

  height:
    38px;

  flex:
    0
    0
    38px;

  display:
    flex;

  align-items:
    center;

  justify-content:
    center;

  border:
    1px
    solid
    var(--accent-strong);

  border-radius:
    10px;

  background:
    var(--accent-soft);

  color:
    var(--accent);

  font-family:
    var(--font-display);

  font-size:
    12px;

  font-weight:
    600;
}

.profile-text {
  min-width:
    0;

  flex:
    1;
}

.profile-name {
  overflow:
    hidden;

  white-space:
    nowrap;

  text-overflow:
    ellipsis;

  font-size:
    10.5px;

  font-weight:
    650;
}

.profile-note {
  margin-top:
    3px;

  color:
    var(--muted);

  font-size:
    8px;

  line-height:
    1.45;
}

.profile-change {
  padding:
    7px
    9px;

  border:
    1px
    solid
    var(--border);

  border-radius:
    7px;

  background:
    var(--surface-3);

  color:
    var(--text-soft);

  cursor:
    pointer;

  font-size:
    8px;

  font-weight:
    650;
}

.profile-change:hover {
  border-color:
    var(--border-strong);

  background:
    var(--surface-4);

  color:
    var(--text);
}


/* ============================================================
   21. MODALS
   ============================================================ */

.modal-overlay {
  position:
    fixed;

  inset:
    0;

  z-index:
    400;

  display:
    none;

  align-items:
    center;

  justify-content:
    center;

  padding:
    15px;

  background:
    rgba(
      4,
      4,
      4,
      .58
    );

  backdrop-filter:
    blur(7px);
}

.modal-overlay.open {
  display:
    flex;
}

.modal {
  width:
    min(
      380px,
      94vw
    );

  padding:
    20px;

  border:
    1px
    solid
    var(--border-strong);

  border-radius:
    14px;

  background:
    var(--surface);

  box-shadow:
    var(--shadow);
}

.modal-title {
  font-family:
    var(--font-display);

  font-size:
    19px;

  font-weight:
    600;
}

.modal-description {
  margin-top:
    6px;

  color:
    var(--muted);

  font-size:
    10px;

  line-height:
    1.6;
}

.modal-input {
  width:
    100%;

  margin-top:
    14px;

  padding:
    10px
    12px;

  border:
    1px
    solid
    var(--border);

  border-radius:
    8px;

  outline:
    none;

  background:
    var(--input);

  color:
    var(--text);

  font-size:
    11px;

  user-select:
    text;
}

.modal-input:focus {
  border-color:
    var(--accent);

  box-shadow:
    0
    0
    0
    3px
    var(--focus);
}

.modal-actions {
  margin-top:
    14px;

  display:
    flex;

  justify-content:
    flex-end;

  gap:
    7px;
}

.modal-button {
  min-height:
    31px;

  padding:
    7px
    11px;

  border:
    1px
    solid
    var(--border);

  border-radius:
    7px;

  background:
    var(--surface-3);

  color:
    var(--text-soft);

  cursor:
    pointer;

  font-size:
    9.5px;

  font-weight:
    650;
}

.modal-button:hover {
  background:
    var(--surface-4);

  border-color:
    var(--border-strong);

  color:
    var(--text);
}

.modal-button.primary {
  border-color:
    var(--accent);

  background:
    var(--accent);

  color:
    var(--accent-ink);
}

.modal-button.primary:hover {
  background:
    var(--accent-hover);

  border-color:
    var(--accent-hover);
}

#usernameModal.first-run
.modal {
  width:
    min(
      410px,
      94vw
    );

  padding:
    23px;
}


/* ============================================================
   22. MOBILE
   ============================================================ */

.sidebar-scrim {
  display:
    none;
}

@media (max-width: 680px) {

  :root {
    --sidebar-width:
      min(
        86vw,
        304px
      );
  }

  .sidebar {
    position:
      fixed;

    inset:
      0
      auto
      0
      0;

    z-index:
      100;

    width:
      var(--sidebar-width);

    min-width:
      0;

    transform:
      translateX(
        -103%
      );

    box-shadow:
      var(--shadow);

    transition:
      transform
      .22s
      var(--ease);
  }

  .sidebar.open {
    transform:
      translateX(0);
  }

  /*
    Desktop's room-list-hidden state should not permanently
    collapse the mobile sidebar.
  */

  body.room-list-hidden
  .sidebar {
    width:
      var(--sidebar-width) !important;

    min-width:
      0 !important;

    border-right:
      1px
      solid
      var(--border) !important;

    pointer-events:
      auto;
  }

  body.room-list-hidden
  .sidebar > * {
    visibility:
      visible;
  }

  .sidebar-scrim {
    position:
      fixed;

    inset:
      0;

    z-index:
      90;

    display:
      none;

    background:
      rgba(
        4,
        4,
        3,
        .48
      );

    backdrop-filter:
      blur(3px);
  }

  .sidebar-scrim.open {
    display:
      block;
  }

  #sidebarToggle {
    display:
      flex;

    position:
      fixed;

    left:
      10px;

    top:
      14px;

    z-index:
      150;

    opacity:
      1;

    pointer-events:
      auto;

    background:
      var(--surface-2);
  }

  .main-header {
    height:
      60px;

    flex-basis:
      60px;

    padding:
      0
      10px
      0
      48px;
  }

  .chat-stage {
    align-items:
      stretch;

    padding:
      8px;
  }

  .chat-surface {
    width:
      100%;

    max-width:
      none;

    height:
      100%;

    min-height:
      0;

    border-radius:
      13px;
  }

  .messages {
    padding:
      15px
      10px
      10px;
  }

  .message {
    max-width:
      92%;
  }

  .message-bubble {
    max-width:
      100%;
  }

  .composer {
    padding:
      6px
      8px
      8px;
  }

  .composer-hint {
    display:
      none;
  }

  .send-button {
    width:
      40px;

    height:
      40px;

    flex-basis:
      40px;
  }

  .settings-panel {
    width:
      100%;

    padding:
      16px
      14px
      20px;
  }
}

@media (max-width: 430px) {

  .theme-grid {
    grid-template-columns:
      1fr;
  }

  .chat-stage {
    padding:
      6px;
  }

  .chat-surface {
    border-radius:
      11px;
  }

  .message {
    max-width:
      94%;
  }

  .send-button {
    width:
      40px;

    height:
      40px;

    flex-basis:
      40px;
  }
}


/* ============================================================
   23. REDUCED MOTION
   ============================================================ */

@media (prefers-reduced-motion: reduce) {

  .depth {
    background:
      radial-gradient(
        circle at center,
        rgba(
          74,
          110,
          96,
          .045
        ),
        transparent
          45%
      );
  }

  .chat-item.is-connected
  .signal-bar,
  .message {
    animation:
      none !important;
  }
}

</style>

</head>

<body>

<canvas
  id="particleCanvas"
  aria-hidden="true"
></canvas>

<div
  class="depth"
  id="depth"
  aria-hidden="true"
></div>

<div
  class="cursor-dot"
  id="cursorDot"
  aria-hidden="true"
></div>

<div
  class="cursor-ring"
  id="cursorRing"
  aria-hidden="true"
></div>

<div
  class="cursor-cross"
  id="cursorCross"
  aria-hidden="true"
></div>


<div class="app">


  <!-- ========================================================
       SIDEBAR
       ======================================================== -->

  <div
    class="sidebar-scrim"
    id="sidebarScrim"
  ></div>


  <aside
    class="sidebar"
    id="sidebar"
  >

    <div class="sidebar-header">

      <div class="brand">

        <div
          class="brand-mark"
          aria-hidden="true"
        >
          W
        </div>

        <div class="brand-text">

          <div class="brand-name">
            Wire
          </div>

          <div class="brand-subtitle">
            quiet, realtime rooms
          </div>

        </div>

      </div>


      <div class="sidebar-actions">

        <button
          class="nav-button"
          id="closeRoomListButton"
          type="button"
          aria-label="Close room list"
          title="Close room list"
        >

          <span
            class="nav-glyph"
            aria-hidden="true"
          >
            &times;
          </span>

          <span>
            Close room list
          </span>

        </button>

      </div>

    </div>


    <div class="sidebar-content">

      <div class="sidebar-heading">
        All rooms
      </div>

      <div
        class="chat-list"
        id="chatList"
      ></div>

    </div>


    <div class="sidebar-footer">

      <button
        class="nav-button"
        id="newChatButton"
        type="button"
        aria-label="Create a new room"
        title="New room"
      >

        <span
          class="nav-glyph"
          aria-hidden="true"
        >
          +
        </span>

        <span>
          New room
        </span>

      </button>


      <button
        class="user-card"
        id="userCard"
        type="button"
        aria-label="Edit display name"
      >

        <div
          class="avatar"
          id="avatar"
        >
          ?
        </div>

        <div class="user-meta">

          <div
            class="user-name"
            id="userNameDisplay"
          >
            Guest
          </div>

          <div class="user-label">
            anonymous profile
          </div>

        </div>

      </button>

    </div>

  </aside>


  <!-- ========================================================
       MAIN
       ======================================================== -->

  <main class="main">

    <header class="main-header">

      <button
        class="small-button"
        id="sidebarToggle"
        type="button"
        aria-label="Open room list"
        title="Open room list"
      >
        &#9776;
      </button>


      <div class="room-title">

        <div
          class="room-icon"
          id="currentRoomIcon"
          aria-hidden="true"
        >

          <span class="signal-bar"></span>
          <span class="signal-bar"></span>
          <span class="signal-bar"></span>

        </div>


        <div class="room-meta">

          <div
            class="room-name"
            id="currentRoomName"
          >
            general
          </div>

          <div
            class="room-state"
            id="currentRoomState"
          >
            Waiting for your name...
          </div>

        </div>

      </div>


      <div class="header-actions">

        <button
          class="small-button"
          id="headerSettingsButton"
          type="button"
          aria-label="Open settings"
          title="Settings"
        >
          &#9881;
        </button>

      </div>

    </header>


    <div class="chat-stage">

      <section
        class="chat-surface"
        aria-label="Conversation"
      >

        <section
          class="messages"
          id="messages"
        ></section>


        <div class="composer">

          <div
            class="reply-bar"
            id="replyBar"
          >

            <div
              class="reply-indicator"
            ></div>

            <div class="reply-content">

              <div class="reply-label">
                Replying to
              </div>

              <div
                class="reply-text"
                id="replyText"
              ></div>

            </div>


            <button
              class="reply-cancel"
              id="cancelReply"
              type="button"
              aria-label="Cancel reply"
            >
              &times;
            </button>

          </div>


          <form
            class="composer-box"
            id="composer"
          >

            <textarea
              id="messageInput"
              class="message-input"
              maxlength="2000"
              placeholder="Enter your name to start..."
              rows="1"
              disabled
              aria-label="Message"
              spellcheck="true"
            ></textarea>


            <button
              class="send-button"
              id="sendButton"
              type="submit"
              disabled
              aria-label="Send message"
              title="Send"
            >

              <span
                class="send-arrow"
                aria-hidden="true"
              >

                <span
                  class="send-arrow-line"
                ></span>

                <span
                  class="send-arrow-head"
                ></span>

              </span>

            </button>

          </form>


          <div class="composer-hint">
            enter to send &middot; shift+enter for a new line
          </div>

        </div>

      </section>

    </div>

  </main>

</div>


<!-- ==========================================================
     SETTINGS
     ========================================================== -->

<div
  class="settings-overlay"
  id="settingsOverlay"
>

  <aside
    class="settings-panel"
    role="dialog"
    aria-modal="true"
    aria-label="Settings"
  >

    <div class="settings-header">

      <div>

        <div class="settings-heading">
          Settings
        </div>

        <div class="settings-subheading">
          appearance &amp; profile
        </div>

      </div>


      <button
        class="close-settings"
        id="closeSettings"
        type="button"
        aria-label="Close settings"
      >
        &times;
      </button>

    </div>


    <section class="settings-section">

      <div class="settings-label">
        Appearance
      </div>


      <div class="settings-card">

        <div class="mode-grid">

          <button
            class="mode-button"
            data-mode="dark"
            type="button"
          >

            <div class="mode-glyph">
              01
            </div>

            <div class="mode-name">
              Dark mode
            </div>

            <div class="mode-description">
              Quiet and subdued
            </div>

          </button>


          <button
            class="mode-button"
            data-mode="light"
            type="button"
          >

            <div class="mode-glyph">
              02
            </div>

            <div class="mode-name">
              Light mode
            </div>

            <div class="mode-description">
              Soft and open
            </div>

          </button>

        </div>

      </div>

    </section>


    <section class="settings-section">

      <div class="settings-label">
        Themes
      </div>


      <div class="settings-card">

        <div class="theme-grid">

          <button
            class="theme-card"
            data-theme="dark"
            type="button"
          >

            <div class="theme-preview">

              <div
                class="preview-a"
                style="background:#191a16"
              ></div>

              <div
                class="preview-b"
                style="background:#24271f"
              ></div>

            </div>

            <div class="theme-title">
              Night
            </div>

            <div class="theme-note">
              ink / sage
            </div>

          </button>


          <button
            class="theme-card"
            data-theme="obsidian"
            type="button"
          >

            <div class="theme-preview">

              <div
                class="preview-a"
                style="background:#111212"
              ></div>

              <div
                class="preview-b"
                style="background:#1b1c1c"
              ></div>

            </div>

            <div class="theme-title">
              Obsidian
            </div>

            <div class="theme-note">
              charcoal / brass
            </div>

          </button>


          <button
            class="theme-card"
            data-theme="light"
            type="button"
          >

            <div class="theme-preview">

              <div
                class="preview-a"
                style="background:#fbfaf5"
              ></div>

              <div
                class="preview-b"
                style="background:#e7e6e0"
              ></div>

            </div>

            <div class="theme-title">
              Daylight
            </div>

            <div class="theme-note">
              chalk / pine
            </div>

          </button>


          <button
            class="theme-card"
            data-theme="paper"
            type="button"
          >

            <div class="theme-preview">

              <div
                class="preview-a"
                style="background:#fbf7ec"
              ></div>

              <div
                class="preview-b"
                style="background:#e4decf"
              ></div>

            </div>

            <div class="theme-title">
              Paper
            </div>

            <div class="theme-note">
              parchment / moss
            </div>

          </button>


          <button
            class="theme-card"
            data-theme="ocean"
            type="button"
          >

            <div class="theme-preview">

              <div
                class="preview-a"
                style="background:#0f1d24"
              ></div>

              <div
                class="preview-b"
                style="background:#163038"
              ></div>

            </div>

            <div class="theme-title">
              Deep Ocean
            </div>

            <div class="theme-note">
              tide / cyan
            </div>

          </button>


          <button
            class="theme-card"
            data-theme="pine"
            type="button"
          >

            <div class="theme-preview">

              <div
                class="preview-a"
                style="background:#18231a"
              ></div>

              <div
                class="preview-b"
                style="background:#28372a"
              ></div>

            </div>

            <div class="theme-title">
              Pine
            </div>

            <div class="theme-note">
              fern / cedar
            </div>

          </button>


          <button
            class="theme-card"
            data-theme="rosewood"
            type="button"
          >

            <div class="theme-preview">

              <div
                class="preview-a"
                style="background:#24151b"
              ></div>

              <div
                class="preview-b"
                style="background:#3b242d"
              ></div>

            </div>

            <div class="theme-title">
              Rosewood
            </div>

            <div class="theme-note">
              wine / petal
            </div>

          </button>

        </div>

      </div>

    </section>


    <section class="settings-section">

      <div class="settings-label">
        Profile
      </div>


      <div class="settings-card">

        <div class="profile-row">

          <div
            class="profile-avatar"
            id="settingsAvatar"
          >
            ?
          </div>


          <div class="profile-text">

            <div
              class="profile-name"
              id="settingsUsername"
            >
              Guest
            </div>

            <div class="profile-note">
              Anonymous profile. Your display name stays on this device.
            </div>

          </div>


          <button
            class="profile-change"
            id="changeUsername"
            type="button"
          >
            Change
          </button>

        </div>

      </div>

    </section>

  </aside>

</div>


<!-- ==========================================================
     NEW ROOM
     ========================================================== -->

<div
  class="modal-overlay"
  id="newChatModal"
>

  <div
    class="modal"
    role="dialog"
    aria-modal="true"
    aria-label="New conversation"
  >

    <div class="modal-title">
      New conversation
    </div>

    <div class="modal-description">
      Choose a room name. Everyone will see it.
    </div>

    <input
      class="modal-input"
      id="newRoomInput"
      maxlength="64"
      placeholder="e.g. coding"
      autocomplete="off"
      aria-label="Room name"
      type="text"
    >

    <div class="modal-actions">

      <button
        class="modal-button"
        id="cancelNewChat"
        type="button"
      >
        Cancel
      </button>

      <button
        class="modal-button primary"
        id="createNewChat"
        type="button"
      >
        Open
      </button>

    </div>

  </div>

</div>


<!-- ==========================================================
     USERNAME
     ========================================================== -->

<div
  class="modal-overlay"
  id="usernameModal"
>

  <div
    class="modal"
    role="dialog"
    aria-modal="true"
    aria-label="Choose your name"
  >

    <div class="modal-title">
      Before we start
    </div>

    <div class="modal-description">
      Choose the name people in your rooms will see.
    </div>

    <input
      class="modal-input"
      id="usernameInput"
      maxlength="32"
      placeholder="Your name"
      autocomplete="nickname"
      aria-label="Your name"
      type="text"
      spellcheck="false"
      autocapitalize="none"
    >

    <div class="modal-actions">

      <button
        class="modal-button"
        id="cancelUsername"
        type="button"
      >
        Later
      </button>

      <button
        class="modal-button primary"
        id="saveUsername"
        type="button"
      >
        Continue
      </button>

    </div>

  </div>

</div>


<script>

/* ============================================================
   FRONTEND CONSTANTS
   ============================================================ */

const MAX_USERNAME_LENGTH = 32;
const MAX_MESSAGE_LENGTH = 2000;
const HISTORY_LIMIT = 100;


/* ============================================================
   DOM
   ============================================================ */

const chatList =
  document.getElementById(
    "chatList"
  );

const newChatButton =
  document.getElementById(
    "newChatButton"
  );

const closeRoomListButton =
  document.getElementById(
    "closeRoomListButton"
  );

const sidebarToggle =
  document.getElementById(
    "sidebarToggle"
  );

const sidebar =
  document.getElementById(
    "sidebar"
  );

const sidebarScrim =
  document.getElementById(
    "sidebarScrim"
  );

const headerSettingsButton =
  document.getElementById(
    "headerSettingsButton"
  );

const settingsOverlay =
  document.getElementById(
    "settingsOverlay"
  );

const closeSettings =
  document.getElementById(
    "closeSettings"
  );

const newChatModal =
  document.getElementById(
    "newChatModal"
  );

const newRoomInput =
  document.getElementById(
    "newRoomInput"
  );

const cancelNewChat =
  document.getElementById(
    "cancelNewChat"
  );

const createNewChat =
  document.getElementById(
    "createNewChat"
  );

const usernameModal =
  document.getElementById(
    "usernameModal"
  );

const usernameInput =
  document.getElementById(
    "usernameInput"
  );

const cancelUsername =
  document.getElementById(
    "cancelUsername"
  );

const saveUsername =
  document.getElementById(
    "saveUsername"
  );

const changeUsername =
  document.getElementById(
    "changeUsername"
  );

const userCard =
  document.getElementById(
    "userCard"
  );

const messages =
  document.getElementById(
    "messages"
  );

const messageInput =
  document.getElementById(
    "messageInput"
  );

const sendButton =
  document.getElementById(
    "sendButton"
  );

const composer =
  document.getElementById(
    "composer"
  );

const currentRoomName =
  document.getElementById(
    "currentRoomName"
  );

const currentRoomState =
  document.getElementById(
    "currentRoomState"
  );

const currentRoomIcon =
  document.getElementById(
    "currentRoomIcon"
  );

const avatar =
  document.getElementById(
    "avatar"
  );

const userNameDisplay =
  document.getElementById(
    "userNameDisplay"
  );

const settingsAvatar =
  document.getElementById(
    "settingsAvatar"
  );

const settingsUsername =
  document.getElementById(
    "settingsUsername"
  );

const replyBar =
  document.getElementById(
    "replyBar"
  );

const replyText =
  document.getElementById(
    "replyText"
  );

const cancelReply =
  document.getElementById(
    "cancelReply"
  );

const particleCanvas =
  document.getElementById(
    "particleCanvas"
  );

const particleContext =
  particleCanvas.getContext(
    "2d",
    {
      alpha: true,
      desynchronized: true,
    }
  );

const depth =
  document.getElementById(
    "depth"
  );

const cursorDot =
  document.getElementById(
    "cursorDot"
  );

const cursorRing =
  document.getElementById(
    "cursorRing"
  );

const cursorCross =
  document.getElementById(
    "cursorCross"
  );


/* ============================================================
   ROOM LIST VISIBILITY
   ============================================================ */

function openSidebar() {

  if (
    window.innerWidth <= 680
  ) {
    document.body.classList.remove(
      "room-list-hidden"
    );

    sidebar.classList.add(
      "open"
    );

    sidebarScrim.classList.add(
      "open"
    );

    sidebar.removeAttribute(
      "aria-hidden"
    );

    return;
  }


  document.body.classList.remove(
    "room-list-hidden"
  );

  sidebar.removeAttribute(
    "aria-hidden"
  );
}


function closeSidebar() {

  if (
    window.innerWidth <= 680
  ) {
    sidebar.classList.remove(
      "open"
    );

    sidebarScrim.classList.remove(
      "open"
    );

    return;
  }


  document.body.classList.add(
    "room-list-hidden"
  );

  sidebar.setAttribute(
    "aria-hidden",
    "true"
  );
}


/*
  Desktop:
  close room list -> collapse it.

  Mobile:
  close room list -> slide it out.
*/

closeRoomListButton.addEventListener(
  "click",
  function (event) {

    event.preventDefault();
    event.stopPropagation();

    closeSidebar();
  }
);


sidebarToggle.addEventListener(
  "click",
  function (event) {

    event.preventDefault();
    event.stopPropagation();

    if (
      window.innerWidth <= 680
    ) {

      if (
        sidebar.classList.contains(
          "open"
        )
      ) {

        closeSidebar();

      } else {

        openSidebar();
      }

      return;
    }


    if (
      document.body.classList.contains(
        "room-list-hidden"
      )
    ) {

      openSidebar();

    } else {

      closeSidebar();
    }
  }
);


sidebarScrim.addEventListener(
  "click",
  function () {
    closeSidebar();
  }
);


/* ============================================================
   CUSTOM CURSOR
   ============================================================ */

let cursorMouseX =
  -1000;

let cursorMouseY =
  -1000;

let cursorRingX =
  -1000;

let cursorRingY =
  -1000;

let cursorVisible =
  false;

let cursorTrailLast =
  0;

const cursorTrailCooldown =
  26;


function updateCursorPosition(
  x,
  y
) {

  cursorMouseX =
    x;

  cursorMouseY =
    y;


  cursorDot.style.left =
    x + "px";

  cursorDot.style.top =
    y + "px";


  cursorCross.style.left =
    x + "px";

  cursorCross.style.top =
    y + "px";


  if (
    !cursorVisible
  ) {

    cursorVisible =
      true;

    cursorDot.style.opacity =
      "1";

    cursorRing.style.opacity =
      "1";

    cursorCross.style.opacity =
      "1";
  }


  depth.style.setProperty(
    "--mouse-x",
    (
      x /
      window.innerWidth
    ) *
      100 +
      "%"
  );


  depth.style.setProperty(
    "--mouse-y",
    (
      y /
      window.innerHeight
    ) *
      100 +
      "%"
  );
}


function animateCursor() {

  cursorRingX +=
    (
      cursorMouseX -
      cursorRingX
    ) *
    0.2;


  cursorRingY +=
    (
      cursorMouseY -
      cursorRingY
    ) *
    0.2;


  cursorRing.style.left =
    cursorRingX + "px";


  cursorRing.style.top =
    cursorRingY + "px";


  requestAnimationFrame(
    animateCursor
  );
}


animateCursor();


function createCursorTrail(
  x,
  y
) {

  if (
    window.matchMedia(
      "(hover: none), (pointer: coarse)"
    ).matches
  ) {
    return;
  }


  const now =
    performance.now();


  if (
    now -
      cursorTrailLast <
    cursorTrailCooldown
  ) {
    return;
  }


  cursorTrailLast =
    now;


  const trail =
    document.createElement(
      "div"
    );


  trail.className =
    "cursor-trail";


  trail.style.left =
    x + "px";


  trail.style.top =
    y + "px";


  document.body.appendChild(
    trail
  );


  const start =
    performance.now();


  function fadeTrail(
    current
  ) {

    const progress =
      Math.min(
        1,
        (
          current -
          start
        ) /
          260
      );


    trail.style.opacity =
      String(
        0.55 -
          progress *
            0.55
      );


    trail.style.transform =
      "translate(-50%, -50%) scale(" +
      (
        1 +
        progress *
          0.5
      ) +
      ")";


    if (
      progress <
      1
    ) {

      requestAnimationFrame(
        fadeTrail
      );

    } else {

      trail.remove();
    }
  }


  requestAnimationFrame(
    fadeTrail
  );
}


document.addEventListener(
  "pointermove",
  function (event) {

    updateCursorPosition(
      event.clientX,
      event.clientY
    );


    createCursorTrail(
      event.clientX,
      event.clientY
    );
  },
  {
    passive:
      true,
  }
);


document.addEventListener(
  "mouseleave",
  function () {

    cursorVisible =
      false;

    cursorDot.style.opacity =
      "0";

    cursorRing.style.opacity =
      "0";

    cursorCross.style.opacity =
      "0";
  }
);


document.addEventListener(
  "pointerdown",
  function (event) {

    if (
      event.pointerType ===
        "mouse" &&
      event.button !==
        0
    ) {
      return;
    }


    updateCursorPosition(
      event.clientX,
      event.clientY
    );


    cursorRing.classList.add(
      "active"
    );


    setTimeout(
      function () {

        cursorRing.classList.remove(
          "active"
        );
      },
      180
    );
  },
  {
    passive:
      true,
  }
);


/* ============================================================
   USER IDENTITY
   ============================================================ */

let userId =
  localStorage.getItem(
    "simpleChatUserId"
  );


if (
  !userId
) {

  userId =
    crypto.randomUUID();


  localStorage.setItem(
    "simpleChatUserId",
    userId
  );
}


let username =
  localStorage.getItem(
    "simpleChatUsername"
  );


function updateProfileUI() {

  const displayName =
    username ||
    "Guest";


  userNameDisplay.textContent =
    displayName;


  settingsUsername.textContent =
    displayName;


  const initial =
    displayName
      .charAt(0)
      .toUpperCase() ||
    "?";


  avatar.textContent =
    initial;


  settingsAvatar.textContent =
    initial;
}


updateProfileUI();


/* ============================================================
   APP STATE
   ============================================================ */

const rooms =
  new Map();

let activeRoomId =
  null;


const OPEN_ROOMS_KEY =
  "simpleChatOpenRooms";

const ACTIVE_ROOM_KEY =
  "simpleChatActiveRoom";

const THEME_KEY =
  "simpleChatTheme";

const MODE_KEY =
  "simpleChatMode";


/* ============================================================
   ROOM STORAGE
   ============================================================ */

function loadOpenRooms() {

  try {

    const parsed =
      JSON.parse(
        localStorage.getItem(
          OPEN_ROOMS_KEY
        ) || "[]"
      );


    if (
      Array.isArray(
        parsed
      )
    ) {

      return parsed;
    }

  } catch {
    // Ignore invalid storage.
  }


  return [
    "general"
  ];
}


function saveOpenRooms() {

  const ids =
    Array.from(
      rooms.values()
    )
      .filter(
        function (
          room
        ) {
          return room.open;
        }
      )
      .map(
        function (
          room
        ) {
          return room.id;
        }
      );


  localStorage.setItem(
    OPEN_ROOMS_KEY,
    JSON.stringify(
      ids
    )
  );
}


function saveActiveRoom() {

  if (
    activeRoomId
  ) {

    localStorage.setItem(
      ACTIVE_ROOM_KEY,
      activeRoomId
    );
  }
}


/* ============================================================
   THEMES
   ============================================================ */

const THEME_CONFIG = {

  dark: {
    mode:
      "dark",

    name:
      "Night",
  },

  light: {
    mode:
      "light",

    name:
      "Daylight",
  },

  obsidian: {
    mode:
      "dark",

    name:
      "Obsidian",
  },

  paper: {
    mode:
      "light",

    name:
      "Paper",
  },

  ocean: {
    mode:
      "dark",

    name:
      "Deep Ocean",
  },

  pine: {
    mode:
      "dark",

    name:
      "Pine",
  },

  rosewood: {
    mode:
      "dark",

    name:
      "Rosewood",
  },
};


function getCurrentTheme() {

  return (
    localStorage.getItem(
      THEME_KEY
    ) ||
    "dark"
  );
}


function getCurrentMode() {

  return (
    localStorage.getItem(
      MODE_KEY
    ) ||
    THEME_CONFIG[
      getCurrentTheme()
    ]?.mode ||
    "dark"
  );
}


function applyTheme(
  theme,
  persist
) {

  if (
    !THEME_CONFIG[
      theme
    ]
  ) {

    theme =
      "dark";
  }


  document.documentElement.setAttribute(
    "data-theme",
    theme
  );


  if (
    persist
  ) {

    localStorage.setItem(
      THEME_KEY,
      theme
    );


    localStorage.setItem(
      MODE_KEY,
      THEME_CONFIG[
        theme
      ].mode
    );
  }


  refreshSettingsButtons();


  requestAnimationFrame(
    function () {

      drawParticleNetwork();
    }
  );
}


function applyMode(
  mode
) {

  const current =
    getCurrentTheme();


  if (
    mode ===
    "light"
  ) {

    const lightThemes =
      [
        "light",
        "paper",
      ];


    applyTheme(
      lightThemes.includes(
        current
      )
        ? current
        : "light",
      true
    );

  } else {

    const darkThemes =
      [
        "dark",
        "obsidian",
        "ocean",
        "pine",
        "rosewood",
      ];


    applyTheme(
      darkThemes.includes(
        current
      )
        ? current
        : "dark",
      true
    );
  }
}


function refreshSettingsButtons() {

  const theme =
    getCurrentTheme();

  const mode =
    getCurrentMode();


  document
    .querySelectorAll(
      ".theme-card"
    )
    .forEach(
      function (
        button
      ) {

        button.classList.toggle(
          "active",
          button.dataset
            .theme ===
            theme
        );
      }
    );


  document
    .querySelectorAll(
      ".mode-button"
    )
    .forEach(
      function (
        button
      ) {

        button.classList.toggle(
          "active",
          button.dataset
            .mode ===
            mode
        );
      }
    );
}


applyTheme(
  getCurrentTheme(),
  false
);


document
  .querySelectorAll(
    ".theme-card"
  )
  .forEach(
    function (
      button
    ) {

      button.addEventListener(
        "click",
        function () {

          applyTheme(
            button.dataset
              .theme,
            true
          );
        }
      );
    }
  );


document
  .querySelectorAll(
    ".mode-button"
  )
  .forEach(
    function (
      button
    ) {

      button.addEventListener(
        "click",
        function () {

          applyMode(
            button.dataset
              .mode
          );
        }
      );
    }
  );


/* ============================================================
   SETTINGS
   ============================================================ */

function openSettings() {

  settingsOverlay.classList.add(
    "open"
  );


  refreshSettingsButtons();
}


function closeSettingsPanel() {

  settingsOverlay.classList.remove(
    "open"
  );
}


headerSettingsButton.addEventListener(
  "click",
  openSettings
);


closeSettings.addEventListener(
  "click",
  closeSettingsPanel
);


settingsOverlay.addEventListener(
  "click",
  function (
    event
  ) {

    if (
      event.target ===
      settingsOverlay
    ) {

      closeSettingsPanel();
    }
  }
);


/* ============================================================
   PARTICLE NETWORK
   ============================================================ */

const PARTICLE_CONFIG = {

  maxParticles:
    300,

  desktopDensity:
    0.000115,

  mobileDensity:
    0.000075,

  minParticles:
    70,

  connectionDistance:
    120,

  mouseRadius:
    145,

  baseRadiusMin:
    1.25,

  baseRadiusMax:
    2.4,

  speedMin:
    0.008,

  speedMax:
    0.025,

  spawnCount:
    5,

  spawnSpeedMin:
    0.008,

  spawnSpeedMax:
    0.03,

  pulseSpeedMin:
    0.00025,

  pulseSpeedMax:
    0.0008,

  colors: {

    sage: {
      r: 147,
      g: 176,
      b: 162,
    },

    blue: {
      r: 87,
      g: 185,
      b: 201,
    },

  },

};


const reducedMotion =
  window.matchMedia(
    "(prefers-reduced-motion: reduce)"
  );


let particleWidth =
  0;

let particleHeight =
  0;

let particleDpr =
  1;

let particles =
  [];

let particleMouse = {
  x:
    -1000,

  y:
    -1000,

  active:
    false,
};

let particleLastTime =
  performance.now();


function particleRandom(
  min,
  max
) {

  return (
    Math.random() *
      (
        max -
        min
      ) +
    min
  );
}


function particleClamp(
  value,
  min,
  max
) {

  return Math.max(
    min,
    Math.min(
      max,
      value
    )
  );
}


function particleDistanceSquared(
  a,
  b
) {

  const dx =
    a.x -
    b.x;

  const dy =
    a.y -
    b.y;

  return (
    dx *
      dx +
    dy *
      dy
  );
}


class Particle {

  constructor(
    x,
    y,
    options = {}
  ) {

    this.x =
      x;

    this.y =
      y;


    const angle =
      options.angle !==
      undefined
        ? options.angle
        : Math.random() *
          Math.PI *
          2;


    const speed =
      options.speed !==
      undefined
        ? options.speed
        : particleRandom(
            PARTICLE_CONFIG
              .speedMin,

            PARTICLE_CONFIG
              .speedMax
          );


    this.vx =
      Math.cos(
        angle
      ) *
      speed;


    this.vy =
      Math.sin(
        angle
      ) *
      speed;


    this.baseRadius =
      options.radius !==
      undefined
        ? options.radius
        : particleRandom(
            PARTICLE_CONFIG
              .baseRadiusMin,

            PARTICLE_CONFIG
              .baseRadiusMax
          );


    this.alpha =
      particleRandom(
        0.68,
        0.86
      );


    this.color =
      options.color ||
      (
        Math.random() <
        0.58
          ? PARTICLE_CONFIG
              .colors
              .sage
          : PARTICLE_CONFIG
              .colors
              .blue
      );


    this.pulse =
      Math.random() *
      Math.PI *
      2;


    this.pulseSpeed =
      particleRandom(
        PARTICLE_CONFIG
          .pulseSpeedMin,

        PARTICLE_CONFIG
          .pulseSpeedMax
      );


    this.phase =
      Math.random() *
      Math.PI *
      2;


    this.wobble =
      particleRandom(
        0.00005,
        0.00015
      );


    this.spawned =
      options.spawned ===
      true;


    this.birth =
      performance.now();
  }


  update(
    dt
  ) {

    if (
      reducedMotion.matches
    ) {

      return;
    }


    const safeDt =
      Math.min(
        dt,
        20
      );


    const time =
      performance.now();


    const wobbleX =
      Math.sin(
        time *
          this.wobble +
          this.phase
      ) *
      0.0012;


    const wobbleY =
      Math.cos(
        time *
          this.wobble *
          0.92 +
          this.phase
      ) *
      0.0012;


    this.x +=
      (
        this.vx +
        wobbleX
      ) *
      safeDt;


    this.y +=
      (
        this.vy +
        wobbleY
      ) *
      safeDt;


    const margin =
      24;


    if (
      this.x <
      -margin
    ) {

      this.x =
        particleWidth +
        margin;

    } else if (
      this.x >
      particleWidth +
        margin
    ) {

      this.x =
        -margin;
    }


    if (
      this.y <
      -margin
    ) {

      this.y =
        particleHeight +
        margin;

    } else if (
      this.y >
      particleHeight +
        margin
    ) {

      this.y =
        -margin;
    }


    this.pulse +=
      this.pulseSpeed *
      safeDt;
  }


  draw() {

    let radius =
      this.baseRadius;


    let alpha =
      this.alpha;


    const pulse =
      Math.sin(
        this.pulse
      ) *
      0.07;


    radius *=
      1 + pulse;


    if (
      particleMouse.active
    ) {

      const dx =
        this.x -
        particleMouse.x;


      const dy =
        this.y -
        particleMouse.y;


      const distance =
        Math.sqrt(
          dx * dx +
          dy * dy
        );


      if (
        distance <
        PARTICLE_CONFIG
          .mouseRadius
      ) {

        const influence =
          1 -
          distance /
            PARTICLE_CONFIG
              .mouseRadius;


        radius *=
          1 +
          influence *
            0.55;


        alpha +=
          influence *
          0.14;
      }
    }


    alpha =
      particleClamp(
        alpha,
        0,
        1
      );


    const r =
      this.color.r;


    const g =
      this.color.g;


    const b =
      this.color.b;


    const glowRadius =
      radius * 5;


    const gradient =
      particleContext
        .createRadialGradient(
          this.x,
          this.y,
          0,
          this.x,
          this.y,
          glowRadius
        );


    gradient.addColorStop(
      0,
      "rgba(" +
        r +
        "," +
        g +
        "," +
        b +
        "," +
        alpha *
          0.30 +
        ")"
    );


    gradient.addColorStop(
      0.3,
      "rgba(" +
        r +
        "," +
        g +
        "," +
        b +
        "," +
        alpha *
          0.09 +
        ")"
    );


    gradient.addColorStop(
      1,
      "rgba(" +
        r +
        "," +
        g +
        "," +
        b +
        ",0)"
    );


    particleContext.beginPath();

    particleContext.fillStyle =
      gradient;


    particleContext.arc(
      this.x,
      this.y,
      glowRadius,
      0,
      Math.PI * 2
    );


    particleContext.fill();


    particleContext.beginPath();

    particleContext.fillStyle =
      "rgba(" +
      r +
      "," +
      g +
      "," +
      b +
      "," +
      alpha +
      ")";


    particleContext.arc(
      this.x,
      this.y,
      radius,
      0,
      Math.PI * 2
    );


    particleContext.fill();
  }

}


function resizeParticleCanvas() {

  particleWidth =
    window.innerWidth;

  particleHeight =
    window.innerHeight;


  particleDpr =
    Math.min(
      window.devicePixelRatio ||
        1,
      2
    );


  particleCanvas.width =
    Math.floor(
      particleWidth *
        particleDpr
    );


  particleCanvas.height =
    Math.floor(
      particleHeight *
        particleDpr
    );


  particleCanvas.style.width =
    particleWidth +
    "px";


  particleCanvas.style.height =
    particleHeight +
    "px";


  particleContext.setTransform(
    particleDpr,
    0,
    0,
    particleDpr,
    0,
    0
  );
}


function calculateInitialParticleCount() {

  const isTouch =
    window.matchMedia(
      "(pointer: coarse)"
    ).matches;


  const density =
    isTouch
      ? PARTICLE_CONFIG
          .mobileDensity
      : PARTICLE_CONFIG
          .desktopDensity;


  return particleClamp(
    Math.floor(
      particleWidth *
      particleHeight *
      density
    ),
    PARTICLE_CONFIG
      .minParticles,
    PARTICLE_CONFIG
      .maxParticles
  );
}


function createInitialParticles() {

  particles.length =
    0;


  const count =
    calculateInitialParticleCount();


  for (
    let i = 0;
    i < count;
    i += 1
  ) {

    particles.push(
      new Particle(
        Math.random() *
          particleWidth,

        Math.random() *
          particleHeight
      )
    );
  }
}


function spawnParticlesAt(
  x,
  y
) {

  for (
    let i = 0;
    i <
    PARTICLE_CONFIG
      .spawnCount;
    i += 1
  ) {

    const angle =
      Math.random() *
      Math.PI *
      2;


    const distance =
      particleRandom(
        0,
        13
      );


    const speed =
      particleRandom(
        PARTICLE_CONFIG
          .spawnSpeedMin,

        PARTICLE_CONFIG
          .spawnSpeedMax
      );


    particles.push(
      new Particle(
        x +
          Math.cos(
            angle
          ) *
          distance,

        y +
          Math.sin(
            angle
          ) *
          distance,

        {
          angle,

          speed,

          radius:
            particleRandom(
              1.5,
              2.7
            ),

          spawned:
            true,

          color:
            Math.random() <
            0.55
              ? PARTICLE_CONFIG
                  .colors
                  .sage
              : PARTICLE_CONFIG
                  .colors
                  .blue,
        }
      )
    );
  }


  if (
    particles.length >
    PARTICLE_CONFIG
      .maxParticles
  ) {

    const overflow =
      particles.length -
      PARTICLE_CONFIG
        .maxParticles;


    particles.splice(
      0,
      overflow
    );
  }
}


function drawParticleConnections() {

  const maxDistance =
    PARTICLE_CONFIG
      .connectionDistance;


  const maxDistanceSquared =
    maxDistance *
    maxDistance;


  particleContext.lineWidth =
    0.55;


  for (
    let i = 0;
    i <
    particles.length;
    i += 1
  ) {

    const a =
      particles[i];


    for (
      let j = i + 1;
      j <
      particles.length;
      j += 1
    ) {

      const b =
        particles[j];


      const distSq =
        particleDistanceSquared(
          a,
          b
        );


      if (
        distSq >
        maxDistanceSquared
      ) {

        continue;
      }


      const distance =
        Math.sqrt(
          distSq
        );


      let alpha =
        1 -
        distance /
          maxDistance;


      alpha *=
        0.18;


      if (
        particleMouse.active
      ) {

        const mouseDistA =
          Math.hypot(
            a.x -
              particleMouse.x,

            a.y -
              particleMouse.y
          );


        const mouseDistB =
          Math.hypot(
            b.x -
              particleMouse.x,

            b.y -
              particleMouse.y
          );


        const closest =
          Math.min(
            mouseDistA,
            mouseDistB
          );


        if (
          closest <
          PARTICLE_CONFIG
            .mouseRadius
        ) {

          const influence =
            1 -
            closest /
              PARTICLE_CONFIG
                .mouseRadius;


          alpha +=
            influence *
            0.06;
        }
      }


      if (
        alpha <=
        0
      ) {

        continue;
      }


      const r =
        (
          a.color.r +
          b.color.r
        ) /
        2;


      const g =
        (
          a.color.g +
          b.color.g
        ) /
        2;


      const bColor =
        (
          a.color.b +
          b.color.b
        ) /
        2;


      particleContext.beginPath();


      particleContext.moveTo(
        a.x,
        a.y
      );


      particleContext.lineTo(
        b.x,
        b.y
      );


      particleContext.strokeStyle =
        "rgba(" +
        r +
        "," +
        g +
        "," +
        bColor +
        "," +
        alpha +
        ")";


      particleContext.stroke();
    }
  }
}


function drawParticleNetwork() {

  particleContext.clearRect(
    0,
    0,
    particleWidth,
    particleHeight
  );


  drawParticleConnections();


  for (
    const particle of
      particles
  ) {

    particle.draw();
  }
}


function animateParticles(
  now
) {

  const rawDelta =
    now -
    particleLastTime;


  particleLastTime =
    now;


  const dt =
    Math.min(
      rawDelta,
      20
    );


  for (
    const particle of
      particles
  ) {

    particle.update(
      dt
    );
  }


  drawParticleNetwork();


  requestAnimationFrame(
    animateParticles
  );
}


function initializeParticleSystem() {

  resizeParticleCanvas();

  createInitialParticles();

  requestAnimationFrame(
    animateParticles
  );
}


document.addEventListener(
  "pointermove",
  function (event) {

    if (
      event.pointerType ===
      "mouse"
    ) {

      particleMouse.x =
        event.clientX;

      particleMouse.y =
        event.clientY;

      particleMouse.active =
        true;
    }
  },
  {
    passive:
      true,
  }
);


document.addEventListener(
  "pointerleave",
  function () {

    particleMouse.active =
      false;
  }
);


document.addEventListener(
  "pointerdown",
  function (event) {

    if (
      event.pointerType ===
        "mouse" &&
      event.button !==
        0
    ) {

      return;
    }


    const target =
      event.target;


    if (
      target &&
      target.closest(
        [
          ".sidebar",
          ".main-header",
          ".chat-surface",
          ".settings-overlay",
          ".modal-overlay",
          "button",
          "input",
          "textarea",
          "select",
          "a",
        ].join(",")
      )
    ) {

      return;
    }


    particleMouse.x =
      event.clientX;


    particleMouse.y =
      event.clientY;


    particleMouse.active =
      true;


    spawnParticlesAt(
      event.clientX,
      event.clientY
    );
  },
  {
    passive:
      true,
  }
);


let particleResizeTimer =
  null;


window.addEventListener(
  "resize",
  function () {

    clearTimeout(
      particleResizeTimer
    );


    particleResizeTimer =
      setTimeout(
        function () {

          resizeParticleCanvas();

          createInitialParticles();

        },
        100
      );
  }
);


initializeParticleSystem();


/* ============================================================
   EMPTY STATE
   ============================================================ */

function showEmptyState() {

  const roomName =
    activeRoomId ||
    "general";


  messages.innerHTML =
    "";


  const wrapper =
    document.createElement(
      "div"
    );


  wrapper.className =
    "empty-state";


  const icon =
    document.createElement(
      "div"
    );


  icon.className =
    "empty-symbol";


  icon.innerHTML =
    '<span class="signal-bar"></span>' +
    '<span class="signal-bar"></span>' +
    '<span class="signal-bar"></span>';


  const title =
    document.createElement(
      "div"
    );


  title.className =
    "empty-title";


  title.textContent =
    "Welcome to #" +
    roomName;


  const description =
    document.createElement(
      "div"
    );


  description.className =
    "empty-description";


  description.textContent =
    "Send the first message in this room.";


  wrapper.appendChild(
    icon
  );


  wrapper.appendChild(
    title
  );


  wrapper.appendChild(
    description
  );


  messages.appendChild(
    wrapper
  );
}


/* ============================================================
   ROOM OBJECTS
   ============================================================ */

function ensureRoom(
  roomId,
  options
) {

  const config =
    options ||
    {};


  if (
    rooms.has(
      roomId
    )
  ) {

    const existing =
      rooms.get(
        roomId
      );


    if (
      config.createdAt !==
      undefined
    ) {

      existing.createdAt =
        config.createdAt;
    }


    if (
      config.global !==
      undefined
    ) {

      existing.global =
        config.global;
    }


    if (
      config.open ===
      true
    ) {

      existing.open =
        true;
    }


    return existing;
  }


  const room = {

    id:
      roomId,

    socket:
      null,

    messages:
      [],

    connected:
      false,

    connecting:
      false,

    open:
      config.open ===
      true,

    global:
      config.global !==
      false,

    createdAt:
      config.createdAt ??
      Date.now(),
  };


  rooms.set(
    roomId,
    room
  );


  return room;
}


/* ============================================================
   GLOBAL ROOM SYNC
   ============================================================ */

let roomSyncInProgress =
  false;


async function syncGlobalRooms() {

  if (
    roomSyncInProgress
  ) {

    return;
  }


  roomSyncInProgress =
    true;


  try {

    const response =
      await fetch(
        "/api/rooms",
        {
          method:
            "GET",

          cache:
            "no-store",
        }
      );


    if (
      !response.ok
    ) {

      return;
    }


    const data =
      await response.json();


    if (
      !data.ok ||
      !Array.isArray(
        data.rooms
      )
    ) {

      return;
    }


    let changed =
      false;


    data.rooms.forEach(
      function (
        remote
      ) {

        const roomId =
          String(
            remote?.id ||
            ""
          ).trim();


        if (
          !/^[a-z0-9_-]{1,64}$/.test(
            roomId
          )
        ) {

          return;
        }


        if (
          rooms.has(
            roomId
          )
        ) {

          const existing =
            rooms.get(
              roomId
            );


          existing.global =
            true;


          if (
            remote.createdAt !==
              undefined &&
            existing.createdAt !==
              remote.createdAt
          ) {

            existing.createdAt =
              remote.createdAt;


            changed =
              true;
          }


          return;
        }


        ensureRoom(
          roomId,
          {
            open:
              false,

            global:
              true,

            createdAt:
              remote.createdAt,
          }
        );


        changed =
          true;
      }
    );


    if (
      !rooms.has(
        "general"
      )
    ) {

      ensureRoom(
        "general",
        {
          open:
            false,

          global:
            true,

          createdAt:
            0,
        }
      );


      changed =
        true;
    }


    if (
      changed
    ) {

      renderChatList();
    }

  } catch (error) {

    console.error(
      "ROOM_SYNC_FAILED:",
      error
    );

  } finally {

    roomSyncInProgress =
      false;
  }
}


/* ============================================================
   ROOM LIST RENDERING
   ============================================================ */

function buildSignalIcon() {

  const icon =
    document.createElement(
      "div"
    );


  icon.className =
    "signal";


  icon.innerHTML =
    '<span class="signal-bar"></span>' +
    '<span class="signal-bar"></span>' +
    '<span class="signal-bar"></span>';


  return icon;
}


function renderChatList() {

  chatList.innerHTML =
    "";


  const sorted =
    Array.from(
      rooms.values()
    ).sort(
      function (
        a,
        b
      ) {

        if (
          a.id ===
          "general"
        ) {

          return -1;
        }


        if (
          b.id ===
          "general"
        ) {

          return 1;
        }


        return (
          (
            a.createdAt ||
            0
          ) -
          (
            b.createdAt ||
            0
          )
        );
      }
    );


  sorted.forEach(
    function (
      room
    ) {

      const item =
        document.createElement(
          "div"
        );


      item.className =
        "chat-item";


      if (
        room.id ===
        activeRoomId
      ) {

        item.classList.add(
          "active"
        );
      }


      if (
        room.connected
      ) {

        item.classList.add(
          "is-connected"
        );
      }


      if (
        room.global &&
        !room.open
      ) {

        item.classList.add(
          "available"
        );
      }


      item.appendChild(
        buildSignalIcon()
      );


      const info =
        document.createElement(
          "div"
        );


      info.className =
        "chat-info";


      const name =
        document.createElement(
          "div"
        );


      name.className =
        "chat-name";


      name.textContent =
        "#" +
        room.id;


      const status =
        document.createElement(
          "div"
        );


      status.className =
        "chat-status";


      if (
        room.connected
      ) {

        status.textContent =
          "connected";

      } else if (
        room.connecting
      ) {

        status.textContent =
          "connecting...";

      } else if (
        room.open
      ) {

        status.textContent =
          "offline";

      } else {

        status.textContent =
          "available";
      }


      info.appendChild(
        name
      );

      info.appendChild(
        status
      );


      item.appendChild(
        info
      );


      if (
        room.open
      ) {

        const close =
          document.createElement(
            "button"
          );


        close.className =
          "chat-close";


        close.type =
          "button";


        close.textContent =
          "×";


        close.title =
          "Close room";


        close.setAttribute(
          "aria-label",
          "Close room"
        );


        close.addEventListener(
          "click",
          function (
            event
          ) {

            event.stopPropagation();


            closeRoom(
              room.id
            );
          }
        );


        item.appendChild(
          close
        );
      }


      item.addEventListener(
        "click",
        function () {

          openRoom(
            room.id
          );


          if (
            window.innerWidth <=
            680
          ) {

            closeSidebar();
          }
        }
      );


      chatList.appendChild(
        item
      );
    }
  );
}


/* ============================================================
   MESSAGE RENDERING
   ============================================================ */

function containsPersian(
  text
) {

  return /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/.test(
    String(
      text ||
      ""
    )
  );
}


function addMessageElement(
  message
) {

  const wrapper =
    document.createElement(
      "div"
    );


  wrapper.className =
    "message";


  wrapper.dataset.messageId =
    message.id;


  if (
    message.userId ===
    userId ||
    (
      username &&
      message.username ===
        username
    )
  ) {

    wrapper.classList.add(
      "mine"
    );
  }


  const hasPersian =
    containsPersian(
      message.text
    ) ||
    containsPersian(
      message.username
    );


  const head =
    document.createElement(
      "div"
    );


  head.className =
    "message-head";


  if (
    hasPersian
  ) {

    head.classList.add(
      "persian-head"
    );
  }


  const usernameEl =
    document.createElement(
      "span"
    );


  usernameEl.className =
    "message-user";


  usernameEl.textContent =
    message.username;


  if (
    containsPersian(
      message.username
    )
  ) {

    usernameEl.classList.add(
      "persian"
    );
  }


  const time =
    document.createElement(
      "span"
    );


  time.className =
    "message-time";


  time.textContent =
    formatTime(
      message.createdAt
    );


  head.appendChild(
    usernameEl
  );


  head.appendChild(
    time
  );


  const bubble =
    document.createElement(
      "div"
    );


  bubble.className =
    "message-bubble";


  bubble.textContent =
    message.text;


  if (
    containsPersian(
      message.text
    )
  ) {

    bubble.classList.add(
      "persian"
    );
  }


  const actions =
    document.createElement(
      "div"
    );


  actions.className =
    "message-actions";


  const isOwn =
    message.userId ===
      userId ||
    (
      username &&
      message.username ===
        username
    );


  if (
    isOwn
  ) {

    const deleteButton =
      document.createElement(
        "button"
      );


    deleteButton.type =
      "button";


    deleteButton.className =
      "message-action delete";


    deleteButton.textContent =
      "Delete";


    deleteButton.title =
      "Delete message";


    deleteButton.addEventListener(
      "click",
      function (
        event
      ) {

        event.stopPropagation();


        if (
          !window.confirm(
            "Delete this message for everyone?"
          )
        ) {

          return;
        }


        deleteMessageFromBackend(
          message.id
        );
      }
    );


    actions.appendChild(
      deleteButton
    );
  }


  const copyButton =
    document.createElement(
      "button"
    );


  copyButton.type =
    "button";


  copyButton.className =
    "message-action copy";


  copyButton.textContent =
    "Copy";


  copyButton.title =
    "Copy message";


  copyButton.addEventListener(
    "click",
    async function (
      event
    ) {

      event.stopPropagation();


      try {

        await navigator.clipboard.writeText(
          message.text
        );

      } catch {

        const temp =
          document.createElement(
            "textarea"
          );


        temp.value =
          message.text;


        temp.style.position =
          "fixed";


        temp.style.opacity =
          "0";


        document.body.appendChild(
          temp
        );


        temp.select();


        try {

          document.execCommand(
            "copy"
          );

        } catch {
          // Ignore.
        }


        temp.remove();
      }


      const original =
        copyButton.textContent;


      copyButton.textContent =
        "Copied";


      setTimeout(
        function () {

          copyButton.textContent =
            original;

        },
        900
      );
    }
  );


  const replyButton =
    document.createElement(
      "button"
    );


  replyButton.type =
    "button";


  replyButton.className =
    "message-action reply";


  replyButton.textContent =
    "Reply";


  replyButton.title =
    "Reply to message";


  replyButton.addEventListener(
    "click",
    function (
      event
    ) {

      event.stopPropagation();


      startReply(
        message
      );
    }
  );


  actions.appendChild(
    copyButton
  );


  actions.appendChild(
    replyButton
  );


  wrapper.appendChild(
    head
  );


  wrapper.appendChild(
    bubble
  );


  wrapper.appendChild(
    actions
  );


  messages.appendChild(
    wrapper
  );
}


function renderRoom(
  room
) {

  messages.innerHTML =
    "";


  if (
    !room.messages.length
  ) {

    showEmptyState();

    return;
  }


  room.messages.forEach(
    function (
      message
    ) {

      addMessageElement(
        message
      );
    }
  );


  scrollToBottom();
}


function addSystemMessage(
  room,
  text
) {

  if (
    room.id !==
    activeRoomId
  ) {

    return;
  }


  const element =
    document.createElement(
      "div"
    );


  element.className =
    "system-message";


  element.textContent =
    text;


  messages.appendChild(
    element
  );


  scrollToBottom();
}


function formatTime(
  timestamp
) {

  return new Date(
    timestamp
  ).toLocaleTimeString(
    [],
    {
      hour:
        "2-digit",

      minute:
        "2-digit",
    }
  );
}


function scrollToBottom() {

  messages.scrollTop =
    messages.scrollHeight;
}


/* ============================================================
   REPLY
   ============================================================ */

let activeReplyMessage =
  null;


function startReply(
  message
) {

  activeReplyMessage =
    message;


  replyText.textContent =
    message.username +
    ": " +
    message.text;


  replyBar.classList.add(
    "open"
  );


  messageInput.focus();
}


function cancelReplyAction() {

  activeReplyMessage =
    null;


  replyText.textContent =
    "";


  replyBar.classList.remove(
    "open"
  );
}


cancelReply.addEventListener(
  "click",
  cancelReplyAction
);


/* ============================================================
   DELETE MESSAGE
   ============================================================ */

function deleteMessageFromBackend(
  messageId
) {

  if (
    !activeRoomId
  ) {

    return;
  }


  const room =
    rooms.get(
      activeRoomId
    );


  if (
    !room ||
    !room.socket ||
    room.socket.readyState !==
      WebSocket.OPEN
  ) {

    return;
  }


  room.socket.send(
    JSON.stringify({
      type:
        "delete",

      messageId:
        messageId,
    })
  );
}


function removeMessageFromRoom(
  room,
  messageId
) {

  const index =
    room.messages.findIndex(
      function (
        message
      ) {

        return (
          message.id ===
          messageId
        );
      }
    );


  if (
    index !==
    -1
  ) {

    room.messages.splice(
      index,
      1
    );
  }


  if (
    room.id !==
    activeRoomId
  ) {

    return;
  }


  const element =
    messages.querySelector(
      '[data-message-id="' +
      CSS.escape(
        messageId
      ) +
      '"]'
    );


  if (
    element
  ) {

    element.remove();
  }


  if (
    !room.messages.length
  ) {

    showEmptyState();
  }
}


/* ============================================================
   OPEN ROOM
   ============================================================ */

function openRoom(
  roomId
) {

  const room =
    ensureRoom(
      roomId,
      {
        open:
          true,

        global:
          true,
      }
    );


  room.open =
    true;


  activeRoomId =
    roomId;


  saveActiveRoom();
  saveOpenRooms();


  currentRoomName.textContent =
    roomId;


  messageInput.placeholder =
    username
      ? "Message #" +
        roomId +
        "..."
      : "Enter your name to start...";


  cancelReplyAction();


  updateRoomStatusUI(
    room
  );


  renderChatList();


  renderRoom(
    room
  );


  messageInput.disabled =
    !username ||
    !room.connected;


  sendButton.disabled =
    !username ||
    !room.connected;


  if (
    username
  ) {

    connectRoom(
      room
    );
  }


  if (
    username &&
    room.connected
  ) {

    messageInput.focus();
  }
}


/* ============================================================
   ROOM STATUS
   ============================================================ */

function updateRoomStatusUI(
  room
) {

  currentRoomIcon.classList.toggle(
    "live",
    !!room.connected
  );


  if (
    !username
  ) {

    currentRoomState.textContent =
      "Waiting for your name";

    return;
  }


  if (
    room.connected
  ) {

    currentRoomState.textContent =
      "Connected";

  } else if (
    room.connecting
  ) {

    currentRoomState.textContent =
      "Connecting...";

  } else {

    currentRoomState.textContent =
      "Disconnected";
  }
}


/* ============================================================
   CONNECT ROOM
   ============================================================ */

function connectRoom(
  room
) {

  if (
    !username
  ) {

    room.connecting =
      false;

    return;
  }


  if (
    !room.open
  ) {

    return;
  }


  if (
    room.socket &&
    (
      room.socket.readyState ===
        WebSocket.OPEN ||
      room.socket.readyState ===
        WebSocket.CONNECTING
    )
  ) {

    return;
  }


  room.connecting =
    true;


  if (
    room.id ===
    activeRoomId
  ) {

    updateRoomStatusUI(
      room
    );


    messageInput.disabled =
      true;


    sendButton.disabled =
      true;
  }


  const protocol =
    location.protocol ===
    "https:"
      ? "wss:"
      : "ws:";


  const socketUrl =
    protocol +
    "//" +
    location.host +
    "/ws/" +
    encodeURIComponent(
      room.id
    ) +
    "?username=" +
    encodeURIComponent(
      username
    ) +
    "&userId=" +
    encodeURIComponent(
      userId
    );


  const socket =
    new WebSocket(
      socketUrl
    );


  room.socket =
    socket;


  socket.addEventListener(
    "open",
    function () {

      if (
        room.socket !==
        socket
      ) {

        return;
      }


      room.connected =
        true;


      room.connecting =
        false;


      if (
        room.id ===
        activeRoomId
      ) {

        updateRoomStatusUI(
          room
        );


        messageInput.disabled =
          false;


        sendButton.disabled =
          false;
      }


      renderChatList();
    }
  );


  socket.addEventListener(
    "message",
    function (
      event
    ) {

      let payload;


      try {

        payload =
          JSON.parse(
            event.data
          );

      } catch {

        return;
      }


      if (
        !payload ||
        typeof payload !==
          "object"
      ) {

        return;
      }


      if (
        payload.type ===
        "connected"
      ) {

        room.messages =
          Array.isArray(
            payload.history
          )
            ? payload.history
            : [];


        if (
          room.id ===
          activeRoomId
        ) {

          renderRoom(
            room
          );
        }


        return;
      }


      if (
        payload.type ===
        "message"
      ) {

        if (
          payload.message
        ) {

          room.messages.push(
            payload.message
          );


          if (
            room.messages.length >
            HISTORY_LIMIT
          ) {

            room.messages =
              room.messages.slice(
                -HISTORY_LIMIT
              );
          }


          if (
            room.id ===
            activeRoomId
          ) {

            addMessageElement(
              payload.message
            );


            scrollToBottom();
          }
        }


        return;
      }


      if (
        payload.type ===
        "message_deleted"
      ) {

        const messageId =
          String(
            payload.messageId ||
              ""
          ).trim();


        if (
          messageId
        ) {

          removeMessageFromRoom(
            room,
            messageId
          );
        }


        return;
      }


      if (
        payload.type ===
          "system" &&
        payload.event ===
          "user_joined"
      ) {

        addSystemMessage(
          room,
          payload.username +
            " joined the room."
        );


        return;
      }


      if (
        payload.type ===
          "system" &&
        payload.event ===
          "user_left"
      ) {

        addSystemMessage(
          room,
          payload.username +
            " left the room."
        );
      }
    }
  );


  socket.addEventListener(
    "close",
    function () {

      if (
        room.socket !==
        socket
      ) {

        return;
      }


      room.socket =
        null;


      room.connected =
        false;


      room.connecting =
        false;


      if (
        room.id ===
        activeRoomId
      ) {

        updateRoomStatusUI(
          room
        );


        messageInput.disabled =
          true;


        sendButton.disabled =
          true;
      }


      renderChatList();
    }
  );


  socket.addEventListener(
    "error",
    function () {

      if (
        room.id ===
        activeRoomId
      ) {

        currentRoomState.textContent =
          "Connection error";
      }
    }
  );
}


/* ============================================================
   CLOSE ROOM
   ============================================================ */

function closeRoom(
  roomId
) {

  const room =
    rooms.get(
      roomId
    );


  if (
    !room
  ) {

    return;
  }


  if (
    room.socket
  ) {

    try {

      room.socket.close(
        1000,
        "Conversation closed"
      );

    } catch {
      // Ignore.
    }
  }


  room.socket =
    null;


  room.connected =
    false;


  room.connecting =
    false;


  room.open =
    false;


  if (
    activeRoomId ===
    roomId
  ) {

    const next =
      Array.from(
        rooms.values()
      ).find(
        function (
          candidate
        ) {

          return candidate.open;
        }
      );


    if (
      next
    ) {

      activeRoomId =
        next.id;


      saveActiveRoom();


      openRoom(
        next.id
      );

    } else {

      const general =
        rooms.get(
          "general"
        ) ||
        ensureRoom(
          "general",
          {
            open:
              true,

            global:
              true,

            createdAt:
              0,
          }
        );


      general.open =
        true;


      activeRoomId =
        "general";


      saveActiveRoom();


      openRoom(
        "general"
      );
    }
  }


  saveOpenRooms();


  renderChatList();
}


/* ============================================================
   CREATE GLOBAL ROOM
   ============================================================ */

async function createRoomGlobally(
  roomId
) {

  try {

    const response =
      await fetch(
        "/api/rooms",
        {
          method:
            "POST",

          headers: {
            "Content-Type":
              "application/json",
          },

          cache:
            "no-store",

          body:
            JSON.stringify({
              roomId,
            }),
        }
      );


    if (
      !response.ok
    ) {

      return false;
    }


    const data =
      await response.json();


    return (
      data.ok ===
      true
    );

  } catch (error) {

    console.error(
      "ROOM_CREATE_FAILED:",
      error
    );


    return false;
  }
}


/* ============================================================
   NEW ROOM MODAL
   ============================================================ */

function openNewChatModal() {

  if (
    !username
  ) {

    openUsernameModal(
      true
    );

    return;
  }


  newRoomInput.value =
    "";


  newChatModal.classList.add(
    "open"
  );


  setTimeout(
    function () {

      newRoomInput.focus();

    },
    40
  );
}


function closeNewChatModal() {

  newChatModal.classList.remove(
    "open"
  );
}


newChatButton.addEventListener(
  "click",
  openNewChatModal
);


cancelNewChat.addEventListener(
  "click",
  closeNewChatModal
);


newChatModal.addEventListener(
  "click",
  function (
    event
  ) {

    if (
      event.target ===
      newChatModal
    ) {

      closeNewChatModal();
    }
  }
);


async function handleCreateNewChat() {

  if (
    !username
  ) {

    openUsernameModal(
      true
    );

    return;
  }


  const roomId =
    newRoomInput.value
      .trim()
      .toLowerCase();


  if (
    !/^[a-z0-9_-]{1,64}$/.test(
      roomId
    )
  ) {

    newRoomInput.focus();

    return;
  }


  createNewChat.disabled =
    true;


  createNewChat.textContent =
    "Opening...";


  try {

    const success =
      await createRoomGlobally(
        roomId
      );


    if (
      !success
    ) {

      return;
    }


    const room =
      ensureRoom(
        roomId,
        {
          open:
            true,

          global:
            true,
        }
      );


    room.open =
      true;


    openRoom(
      roomId
    );


    await syncGlobalRooms();


    closeNewChatModal();

  } finally {

    createNewChat.disabled =
      false;

    createNewChat.textContent =
      "Open";
  }
}


createNewChat.addEventListener(
  "click",
  handleCreateNewChat
);


newRoomInput.addEventListener(
  "keydown",
  function (
    event
  ) {

    if (
      event.key ===
      "Enter"
    ) {

      event.preventDefault();

      handleCreateNewChat();
    }


    if (
      event.key ===
      "Escape"
    ) {

      closeNewChatModal();
    }
  }
);


/* ============================================================
   SEND MESSAGE
   ============================================================ */

function sendMessage() {

  if (
    !username
  ) {

    openUsernameModal(
      true
    );

    return;
  }


  if (
    !activeRoomId
  ) {

    return;
  }


  const room =
    rooms.get(
      activeRoomId
    );


  if (
    !room ||
    !room.socket ||
    room.socket.readyState !==
      WebSocket.OPEN
  ) {

    return;
  }


  const text =
    messageInput.value.trim();


  if (
    !text
  ) {

    return;
  }


  if (
    text.length >
    MAX_MESSAGE_LENGTH
  ) {

    return;
  }


  room.socket.send(
    JSON.stringify({
      type:
        "message",

      text,
    })
  );


  messageInput.value =
    "";


  messageInput.classList.remove(
    "persian-input"
  );


  messageInput.style.direction =
    "ltr";


  messageInput.style.textAlign =
    "left";


  cancelReplyAction();


  resizeTextarea();


  messageInput.focus();
}


composer.addEventListener(
  "submit",
  function (
    event
  ) {

    event.preventDefault();

    sendMessage();
  }
);


messageInput.addEventListener(
  "keydown",
  function (
    event
  ) {

    if (
      event.key ===
        "Enter" &&
      !event.shiftKey
    ) {

      event.preventDefault();

      sendMessage();
    }
  }
);


function resizeTextarea() {

  messageInput.style.height =
    "auto";


  messageInput.style.height =
    Math.min(
      messageInput.scrollHeight,
      160
    ) +
    "px";
}


messageInput.addEventListener(
  "input",
  function () {

    const isPersian =
      containsPersian(
        messageInput.value
      );


    messageInput.classList.toggle(
      "persian-input",
      isPersian
    );


    messageInput.style.direction =
      isPersian
        ? "rtl"
        : "ltr";


    messageInput.style.textAlign =
      isPersian
        ? "right"
        : "left";


    resizeTextarea();
  }
);


/* ============================================================
   USERNAME MODAL
   ============================================================ */

let usernameModalFirstRun =
  false;


function openUsernameModal(
  firstRun
) {

  usernameModalFirstRun =
    !!firstRun;


  usernameModal.classList.toggle(
    "first-run",
    !!firstRun
  );


  usernameInput.value =
    username ||
    "";


  cancelUsername.textContent =
    firstRun
      ? "Later"
      : "Cancel";


  saveUsername.textContent =
    firstRun
      ? "Continue"
      : "Save";


  usernameModal.classList.add(
    "open"
  );


  setTimeout(
    function () {

      usernameInput.focus();


      if (
        username
      ) {

        usernameInput.select();
      }

    },
    50
  );
}


function closeUsernameModal() {

  usernameModal.classList.remove(
    "open"
  );


  usernameModal.classList.remove(
    "first-run"
  );


  usernameModalFirstRun =
    false;
}


changeUsername.addEventListener(
  "click",
  function () {

    openUsernameModal(
      false
    );
  }
);


userCard.addEventListener(
  "click",
  function () {

    openUsernameModal(
      false
    );
  }
);


cancelUsername.addEventListener(
  "click",
  function () {

    if (
      usernameModalFirstRun &&
      !username
    ) {

      closeUsernameModal();


      currentRoomState.textContent =
        "Waiting for your name";


      messageInput.disabled =
        true;


      sendButton.disabled =
        true;


      return;
    }


    closeUsernameModal();
  }
);


usernameModal.addEventListener(
  "click",
  function (
    event
  ) {

    if (
      event.target ===
      usernameModal
    ) {

      if (
        usernameModalFirstRun &&
        !username
      ) {

        return;
      }


      closeUsernameModal();
    }
  }
);


saveUsername.addEventListener(
  "click",
  function () {

    const newName =
      String(
        usernameInput.value ??
          ""
      ).trim();


    if (
      !newName
    ) {

      usernameInput.focus();

      return;
    }


    if (
      newName.length >
      MAX_USERNAME_LENGTH
    ) {

      usernameInput.focus();

      return;
    }


    username =
      newName;


    localStorage.setItem(
      "simpleChatUsername",
      username
    );


    updateProfileUI();


    closeUsernameModal();


    rooms.forEach(
      function (
        room
      ) {

        if (
          room.open
        ) {

          connectRoom(
            room
          );
        }
      }
    );


    if (
      activeRoomId
    ) {

      const room =
        rooms.get(
          activeRoomId
        );


      if (
        room
      ) {

        updateRoomStatusUI(
          room
        );


        messageInput.placeholder =
          "Message #" +
          room.id +
          "...";


        messageInput.disabled =
          !room.connected;


        sendButton.disabled =
          !room.connected;


        renderRoom(
          room
        );
      }
    }
  }
);


usernameInput.addEventListener(
  "input",
  function () {

    if (
      containsPersian(
        usernameInput.value
      )
    ) {

      usernameInput.style.fontFamily =
        '"Vazirmatn", var(--font-ui)';

    } else {

      usernameInput.style.fontFamily =
        "";
    }
  }
);


usernameInput.addEventListener(
  "keydown",
  function (
    event
  ) {

    if (
      event.key ===
      "Enter"
    ) {

      event.preventDefault();

      saveUsername.click();
    }


    if (
      event.key ===
      "Escape"
    ) {

      if (
        usernameModalFirstRun &&
        !username
      ) {

        return;
      }


      closeUsernameModal();
    }
  }
);


/* ============================================================
   ESCAPE
   ============================================================ */

document.addEventListener(
  "keydown",
  function (
    event
  ) {

    if (
      event.key ===
      "Escape"
    ) {

      closeSettingsPanel();

      closeNewChatModal();


      if (
        !usernameModalFirstRun ||
        username
      ) {

        closeUsernameModal();
      }
    }
  }
);


/* ============================================================
   BOOT
   ============================================================ */

async function boot() {

  /*
    Start with the global room directory.
  */

  await syncGlobalRooms();


  /*
    Load locally opened rooms.
  */

  const savedOpenRooms =
    loadOpenRooms();


  /*
    Always guarantee general.
  */

  if (
    !rooms.has(
      "general"
    )
  ) {

    ensureRoom(
      "general",
      {
        open:
          savedOpenRooms.includes(
            "general"
          ),

        global:
          true,

        createdAt:
          0,
      }
    );
  }


  /*
    Restore previously opened rooms.
  */

  savedOpenRooms.forEach(
    function (
      roomId
    ) {

      if (
        rooms.has(
          roomId
        )
      ) {

        rooms.get(
          roomId
        ).open =
          true;

      } else {

        ensureRoom(
          roomId,
          {
            open:
              true,

            global:
              true,
          }
        );
      }
    }
  );


  /*
    Restore active room.
  */

  const savedActive =
    localStorage.getItem(
      ACTIVE_ROOM_KEY
    );


  let active =
    rooms.has(
      savedActive
    )
      ? savedActive
      : null;


  if (
    !active
  ) {

    const opened =
      Array.from(
        rooms.values()
      ).find(
        function (
          room
        ) {

          return room.open;
        }
      );


    if (
      opened
    ) {

      active =
        opened.id;
    }
  }


  if (
    !active
  ) {

    const general =
      rooms.get(
        "general"
      );


    general.open =
      true;


    active =
      "general";
  }


  openRoom(
    active
  );


  refreshSettingsButtons();


  renderChatList();


  drawParticleNetwork();


  /*
    New user gets the username modal.
  */

  if (
    !username
  ) {

    setTimeout(
      function () {

        openUsernameModal(
          true
        );
      },
      120
    );
  }


  /*
    Keep the global room list
    synchronized for all users.
  */

  setInterval(
    syncGlobalRooms,
    ROOM_SYNC_INTERVAL
  );
}


boot();

</script>

</body>
</html>
`;
