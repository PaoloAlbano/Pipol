# Message authenticity

Who wrote a message, and who may change it. This page is about the members of a conversation; what the relay and the TURN server can see is in [Relay server](relay.md#what-the-relay-can-see) and [TURN and calls](turn.md).

## What is signed

Every message, edit, deletion and reaction is signed in the sender's browser with their identity key (Ed25519), and whoever receives it checks the signature. It does not matter how it arrives: live, through the relay, or forwarded by another member as part of the history.

| Item | What the signature covers | What the receiver does |
|------|---------------------------|------------------------|
| Message (text or image) | Id, type, author's key, username, time, content, thread parent, file name and size, and a hash of the image | Drops it if the signature is missing or wrong, or if it was signed for another room. Only the signed fields are kept |
| Edit | Message id, new text, time of the edit | Applies it only if it was signed by the author of that message. The latest edit wins |
| Deletion | Message id | Applies it only if it was signed by the author. A deleted message stays deleted |
| Reaction | Message id, emoji, added or removed, time | Applies it to the user who signed it. A reaction older than the latest one from the same user and emoji is ignored, so replaying an old one cannot undo a newer one |

Every signature also covers the room it was made for (a channel, a conversation or a quick room), so a message cannot be copied into another room.

## What this means

- A member **cannot write as somebody else**, nor edit or delete another member's messages, nor add reactions on their behalf. The same holds for the history another member gives you: they cannot invent or change messages.
- The history a peer gives you carries the original signed messages together with the signed edits and deletions, so you can verify it all without trusting that peer.
- Messages without a valid signature are **dropped**, including those from versions of the app that predate signatures. The history from before this feature is only available from the device that already had it. A device signs its own old messages when it opens the app, so it can share them from then on.
- In a direct message, edits, deletions and reactions travel inside the encrypted message, like the message itself, so the rest of the workspace does not see them.

## What it does not cover

- A signature proves which **key** wrote something, not who the person is. A member can create a new identity with the same username as someone else. Compare the names with care when it matters.
- Typing indicators, presence and channel lists are not signed.
- Images sent in a direct message still travel as ordinary channel traffic, visible to the other members of the workspace (not to the relay: it is encrypted with the workspace key). Messages are not affected.
