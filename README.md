# Orbit

A chat app with email-verified accounts with unique, changeable usernames.

Email is optional at signup. Accounts with an email use verification and can
recover access by password reset. Leaving email blank starts a username-only
guest session that lasts until logout or seven days, whichever comes first;
guest sessions have no password and cannot be recovered.

General chat uses Socket.IO to deliver messages live to other connected users.
Messages are not saved, so users must be online in the chat at the same time.
Each active login session gets a balanced pastel color for other users' message
bubbles; the color stays with that session until logout or expiry.

The sidebar lists currently connected sessions. Select Request to invite
someone to a one-to-one chat; they can accept or decline, and accepted chats
appear under Private chats. Presence, requests, and private conversations are
live-only and reset when a participant disconnects or the server restarts.
If a participant logs out, the other user keeps the open conversation and sees
that they logged out; messages are disabled until they are available again.
Use Leave chat from the conversation header or sidebar to remove the private
conversation from your list.

# TO DO:

Unread message badges — show unread counts on chats in the sidebar.

Message timestamps — subtle times beside messages, with date separators between days.

Search in conversation — find a message without scrolling through the whole chat.

Better mobile layout — make the sidebar and conversation switch cleanly on small screens.

Empty states — helpful prompts when there are no private chats, requests, or messages.

Connection/reconnect feedback — make it clear when chat is reconnecting or offline.

Message actions — hover/tap controls for copying a message or reacting with an emoji.
