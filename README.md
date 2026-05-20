# Blueberry Browser

> **⚠️ Disclaimer:** I'm not proud of this codebase! It was built in 3 hours. If you have some time left over in the challenge, feel free to refactor and clean things up!

https://github.com/user-attachments/assets/bbf939e2-d87c-4c77-ab7d-828259f6d28d

---

## What Blueberry Is

**Blueberry is a delegation runtime for agentic systems.** Other AI agents
(Hermes, Claude projects, n8n flows, cron jobs, anything that speaks MCP) hand
Blueberry a natural-language task — *"Message 'Hello how is it going' to Leif
Adamec Rydenfalk on LinkedIn"*, *"Send this Gmail to ledamecrydenfalk@gmail.com:
<body>"*, *"Pull the last 50 transactions from my bank dashboard into a CSV"* —
and Blueberry **performs that task in a real browser as if it were a human**.

Two things distinguish it from "another browser-using agent":

1. **Human-equivalent execution.** Blueberry uses the same DOM, clicks the same
   buttons, fills the same forms a person would. No site-specific scrapers, no
   bespoke API integrations, no headless tricks that sites can detect. If a
   human can do it in a browser, Blueberry can do it.
2. **It's a callable endpoint, not just an app.** Blueberry exposes itself over
   the Model Context Protocol (MCP) so any other agent on the system — or any
   remote agent over HTTP+SSE — can delegate web-UI work to it and await a
   structured result. The destructive-action gate still routes through the
   local human on the desktop, so unattended automation stays safe.

See [`MCP_DELEGATION.md`](./MCP_DELEGATION.md) for the protocol, the tool
schema, and how to wire an external agent up to a running Blueberry.

---

## Original Challenge

You are the **CTO of Blueberry Browser**, a Strawberry competitor. Your mission is to add a feature to Blueberry that makes it superior & more promising than Strawberry.

But your time is limited—Strawberry is about to raise a two billion dollar Series A round from X-Separator, B17Å and Sequoiadendron giganteum Capital.

## 🎯 Task

Your job is to **clone this repo** and add a unique feature. Some ideas are listed below.

It doesn't need to work 100% reliably, or even be completely done. It just has to:

- Show that you are creative and can iterate on novel ideas fast
- Demonstrate good system thinking and code practices  
- Prove you are a capable full stack and/or LLM dev

Once you're done, we'll book a call where you'll get to present your work!

If it's cracked, we might just have to acquire Blueberry Browser to stay alive 👀👀👀

### ⏰ Time

**1-2 weeks** is ideal for this challenge. This allows you to work over weekends and during evenings in your own time.

### 📋 Rules

You are allowed to vibe code, but make sure you understand everything so we can ask technical questions.

## 💡 Feature Ideas

### **Browsing History Compiler**
Track the things that the user is doing inside the browser and figure out from a series of browser states what the user is doing, and perhaps how valuable, repetitive tasks can be re-run by an AI agent.

*Tab state series → Prompt for web agent how to reproduce the work*

### **Coding Agent**
Sidebar coding agent that can create a script that can run on the open tabs.

Maybe useful for filling forms or changing the page's style so it can extract data but present it in a nicer format.

### **Tab Completion Model**
Predict next action or what to type, like Cursor's tab completion model.

### **Your Own Idea**
Feel free to implement your own idea!

> Wanted to try transformers.js for a while? This is your chance! 

> Have an old cool web agent framework you built? Let's see if you can merge it into the browser!

> Think you can add a completely new innovation to the browser concept with some insane, over-engineered React? Lfg!

Make sure you can realistically showcase a simple version of it in the timeframe. You can double check with us first if uncertain! :)

## 💬 Tips

Feel free to write to us with questions or send updates during the process—it's a good way to get a feel for working together.

It can also be a good way for us to give feedback if things are heading in the right or wrong direction.

---

## 🚀 Project Setup

### Install
```bash
$ pnpm install
```

### Development
```bash
$ pnpm dev
```

**Add an OpenAI API key to `.env`** in the root folder.

Strawberry will reimburse LLM costs, so go crazy! *(Please not more than a few hundred dollars though!)*
