# Takeing back the newsfeed

Feedeater's name is literal: it's a backplane and an engine for tools that munch on and digest the modern world's ever-expanding sprawl of newsfeeds, social media apps, notifications, alerts, chats, and reminders that we're all stuck trying to stomach every day.

It's a backplane to unite an ecosystem of lightweight and modular tools that empowers people to assemble their own darn newsfeeds policed and moderated by their own darn algorythms (blackjack and hookers optional).

# Context is King
Rather then rigied and archaic system-specific concepts like "threads" or "topics" or "channels" or "conversations" or "Hashtags", Feedeater's unified data model groups messages by "Contexts". 

**Contexts allow deep knowedge**: FeedEater tracks AI summaries and semantic embeds for messages in a given context. This allows both humans any any sorting/filtering/monitoring processes to understand a given message at a much deeper level.

**Contexts may span platforms**: FeedEater allows the tracking of topics and conversations across platforms by allowing messages and information coming from diffent systems to be related to the same context. 

**Contexts allow deep control**: [future feature] FeedEater allows feed filtering and monitoring (job triggering) based on semantic search. 

# Batteries Included Platform
FeedEater makes it easy to collect, aggriate, process, and filter feeds like news, chats, message, and notifications by providing unified data structures and support services: 

- **Drop-in installs**: FeedEater will automatically import and integrate with any module cloned into its /modules folder (see an [example module](https://github.com/SparksMcGhee/FeedEater/tree/main/modules/example)).
- **Free Orchestration**: Modules may define jobs which FeedEater will invoke either on a schedule, based on message/context subscription rules, or based on button presses in the web interface.  
- **External intergration**: Jobs may make external API calls 
- **Unified Message Bus**: All modules can read and emit messages on a unified, persistant, and realtime message bus.
- **Collabrative understanding**: Modules can collaborate on a shared understanding of those messages by emitting key-value tags on any message (not just theirs)
- **AI all warmed up**: Modules are provided system endpoints for interacting with a vLLM backend (OpenAI-compatible). No fussing with API keys, networking, sidecar services, or waiting for models to load. FeedEater abstracts the summary and embedding endpoints and can optionally route summary requests to a cloud provider (burst mode). 
- **Free Logging**: FeedEater logs and monitors jobs as well as providing a unified realtime debug log accessible from the UI. 
- **Free Settings**: FeedEater handles exposing module settings to the end-user via the web interface as well as securely and persistantly storing settings values.  
- **Free UI**: Modules may expand their settings page by defining their own TypeScript cards for any additional interoperability, as well as defining the card which is displayed when a user clicks on one of it's messages. 
- **Free Persistance**: Modules get their own schema on the Postgres backend to store persistant data. Schema definitions via Prisma. 
- **Free Message Queue**: Modules get their own namespace on FeedEater's NATs message queue. 

# Why FeedEater? 
For most of human history the biggest challenge we faced was getting enough food. Our brains are wired to consume all the greese, salt, carbs, and sugar we could cram into our mouths becuase for most of history the threat of heart diease was laughable compared to the looming monster of starvation.  

Then, in an evolutionary blink of the eye the hard times ended. Developed nations didn't just have enough food, we had too much food. Suddenly the biggest killer and threat to our wellbeing wasn't starving, it was obesity, diabetes, and heart problems... suddenly success wasn't eating enough, it was eating right. 

It took us years of experimenting, medical reserch, fad diets, public education campaigns, and food regulation to get the situation under control. 

Our natural desire for knowledge and closeness is, like hunger, is rooted in the same fear. Knowledge and social closeness increases our evolutionary advantage and for most of human history we were starving and scratching for every tidbit.

Then, in the same evolutionary blink of the eye the whole game changed. Suddenly the Internet allowed us to pump all of humanitites knowledge along with every baniel thought and cat picture directly into our eyeballs 24/7/365. Suddenly becoming wise, informed, and healthy required careful information dieting. 

Since Facebook, Twitter, Tik-Toc, Bluesky, Mastadon, RSS feeds, Slack, Discord, IRC, SMS, Signal, Telegram, WeChat, Email.... appear to have collectively decided that pumping volumes of unhealthy and outright dangerious information into our eyeballs is more prophetable we're going to have to take matters into our own hands. 

## 🚀 Deploying FeedEater

### Prerequisites
- Ansible installed locally (`pip install ansible`)
- Docker + Docker Compose on the target host
- A vLLM instance serving a generative model (port 8888) and an embedding model (port 8889), both on the OpenAI-compatible `/v1` API

### First-time setup

1. **Copy the example env file** and fill in all values:
   ```bash
   cp .env.example .env   # or create .env from scratch
   ```

2. **Generate persistent secrets** — do this once and never regenerate them:
   ```bash
   # FEED_SETTINGS_KEY — encrypts module secrets stored in the database
   python3 -c "import os,base64; print('FEED_SETTINGS_KEY=' + base64.b64encode(os.urandom(32)).decode())"

   # FEED_INTERNAL_TOKEN — authenticates internal API calls (worker → API)
   python3 -c "import os,base64; print('FEED_INTERNAL_TOKEN=' + base64.b64encode(os.urandom(32)).decode())"
   ```
   Add both values to your local `.env`.

3. **Set your vLLM URLs** in `.env`:
   ```
   AI_BASE_URL=http://<your-host>:8888/v1
   AI_EMBED_BASE_URL=http://<your-host>:8889/v1
   AI_EMBED_DIM=768
   ```

4. **Deploy:**
   ```bash
   make deploy
   ```
   This sources `.env`, exports all variables into the shell, and runs the Ansible playbook. Ansible reads `FEED_SETTINGS_KEY` and `FEED_INTERNAL_TOKEN` from the environment and writes them to the server's `.env`  — keeping your local `.env` as the single source of truth.

> ⚠️ **Key safety:** `FEED_SETTINGS_KEY` encrypts sensitive settings (bot tokens, API keys) stored in the database. If you ever need to rotate it, you must first clear all encrypted values from the `Setting` table in Postgres, or the API will crash on startup. Back up your `.env` and treat `FEED_SETTINGS_KEY` like a database master password.

---

## 🤝 Contributing

Yes please! 

**🤖 responsibly,  my friends**