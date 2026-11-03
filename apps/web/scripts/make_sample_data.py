"""Writes public/sample-data/: made-up examples with features and answers, for the stand-ins.

The real pilot data never goes in this repo. Run: python3 scripts/make_sample_data.py
"""
import json, random, os

random.seed(7)
OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'sample-data')

# title, description, on-screen text, speech, primary_value, format, topics, type
POSTS = [
  ("Rent a flat in Lisbon: 5 things to check", "Moving to Lisbon? Check these before you sign.", "1. WATER PRESSURE", "First, open every tap and check the pressure...", "Practical", "Tutorial", ["Home & renting", "Travel"], "video"),
  ("Talk show clip: chef on remote work", "From last night's show #clip", "LIVE", "I think remote work changed how we eat lunch...", "Entertainment", "Clip", ["Work & money", "Food & drink"], "video"),
  ("My cat vs. the new sofa", "She won. Again.", "DAY 3", "No no no, not the corner...", "Entertainment", "Vlog", ["Pets & animals", "Home & renting"], "video"),
  ("Is this air fryer worth it? Honest review", "Honest review after 14 days. Link in bio for 20% off!", "CODE: FRY20", "So I've been using this for two weeks...", "Ecosystem issue", "Review", ["Food & drink", "Tech"], "video"),
  ("5 cheap lunches near the office", "Under 8 euros each, all walkable.", "€7.50", "Number one is the bakery on the corner...", "Practical", "Tutorial", ["Food & drink", "Work & money"], "video"),
  ("Our first week in Porto", "Week one done. We love it already.", "PORTO", "Okay so this is our street...", "Entertainment", "Vlog", ["Travel"], "video"),
  ("Why I quit my agency job", "Long story, here is my take. Tell me yours.", "", "I want to talk about why I left...", "Discussion", "Vlog", ["Work & money"], "video"),
  ("This serum changed my skin (code inside)", "Use my code GLOW15 at checkout", "GLOW15", "I've been using this every night...", "Ecosystem issue", "Review", ["Beauty & fashion"], "photo_text"),
  ("How to fix a slow laptop in 3 steps", "Works on most machines from the last 5 years.", "STEP 1", "Open the task manager first...", "Practical", "Tutorial", ["Tech"], "video"),
  ("When your boss says 'quick call'", "We've all been there", "", "Hey, got a minute? It'll be quick...", "Entertainment", "Skit", ["Work & money"], "video"),
  ("Phone camera test: night mode", "Same street, three phones. Which wins?", "PHONE A / PHONE B", "This is the first shot at 11pm...", "Practical", "Review", ["Tech"], "video"),
  ("Remote work is overrated. Change my mind", "Hot take: offices are better for juniors.", "", "Here's what I've seen in five years...", "Discussion", "Other", ["Work & money"], "photo_text"),
  ("Street food tour in Bangkok", "Twelve dishes, one night.", "STOP 4", "This is the pad thai place everyone talks about...", "Entertainment", "Vlog", ["Food & drink", "Travel"], "video"),
  ("Stretching routine for desk workers", "Ten minutes, no equipment.", "HOLD 30s", "Sit tall and roll your shoulders back...", "Practical", "Tutorial", ["Health & fitness", "Work & money"], "video"),
  ("Movie scene that still makes me cry", "From the 2019 film. #clip #movies", "", "You were always there for me...", "Entertainment", "Clip", ["News & society"], "video"),
  ("Get rich with this one app!!!", "Guaranteed 300% returns, DM me", "300% PROFIT", "My friend made ten thousand in a week...", "Ecosystem issue", "Other", ["Work & money", "Tech"], "photo_text"),
  ("Unpopular opinion: tipping should end", "Let's talk about it. What do you think?", "", "I worked in restaurants for six years...", "Discussion", "Vlog", ["Food & drink", "News & society"], "video"),
  ("Board game night: our top 3", "For groups of 4 to 6.", "TOP 3", "Number three is a quick card game...", "Practical", "Review", ["Games"], "photo_text"),
  ("Speedrun world record reaction", "He did it!! #gaming #clip", "WR", "No way, no way, he skipped the whole level...", "Entertainment", "Clip", ["Games"], "video"),
  ("What to pack for a week in Iceland", "My full list, including what I forgot.", "PACKING LIST", "Layers are everything...", "Practical", "Tutorial", ["Travel"], "photo_text"),
  ("Puppy's first beach day", "He was scared of the waves at first.", "", "Come on buddy, it's just water...", "Entertainment", "Vlog", ["Pets & animals", "Travel"], "video"),
  ("City council votes on bike lanes", "My view on yesterday's vote. Agree?", "", "I cycle to work every day, so here's my take...", "Discussion", "Vlog", ["News & society"], "video"),
  ("Make-up look in 5 minutes", "Everyday look, drugstore only.", "5 MIN", "Start with a light moisturiser...", "Practical", "Tutorial", ["Beauty & fashion"], "video"),
  ("Waiter vs. customer who 'knows wine'", "Based on a true story", "", "I'd like the 2015, it has more legs...", "Entertainment", "Skit", ["Food & drink"], "video"),
  ("Budget for my first salary", "How I split it, 50/30/20.", "50 / 30 / 20", "Fifty percent goes to needs...", "Practical", "Tutorial", ["Work & money"], "photo_text"),
  ("Late night stream highlights", "Best moments from Friday's stream", "", "Chat, did you see that?...", "Entertainment", "Clip", ["Games"], "video"),
  ("Is the new smartwatch worth it?", "After a month of use. Not sponsored.", "", "Battery is the big question...", "Practical", "Review", ["Tech", "Health & fitness"], "video"),
  ("Fake giveaway: win a phone", "Like, share and send 2 euros to enter!", "FREE PHONE", "To enter just send a small fee...", "Ecosystem issue", "Other", ["Tech"], "photo_text"),
  ("Apartment tour: 30 square metres", "Small but it works.", "30 m²", "This is the whole place, basically...", "Entertainment", "Vlog", ["Home & renting"], "video"),
  ("Why fast fashion has to stop", "My thoughts after reading the report. Discuss.", "", "I read the whole report so you don't have to...", "Discussion", "Other", ["Beauty & fashion", "News & society"], "photo_text"),
  ("Home workout: no gym needed", "Full body, 20 minutes.", "ROUND 2", "Let's start with squats...", "Practical", "Tutorial", ["Health & fitness"], "video"),
  ("Interview clip: economist on rents", "From this morning's interview #clip", "", "Rents rose faster than wages this year...", "Entertainment", "Clip", ["Home & renting", "News & society"], "video"),
  ("Trying every snack in a Tokyo store", "Rating them 1 to 10.", "8/10", "Okay this one is shrimp flavoured...", "Entertainment", "Review", ["Food & drink", "Travel"], "video"),
  ("Cat translator app review", "Does it work? Sort of. Ad: thanks to the app for sponsoring", "AD", "It says she wants food. Shocking...", "Entertainment", "Review", ["Pets & animals", "Tech"], "video"),
  ("How I prepare for job interviews", "My checklist, free to copy.", "CHECKLIST", "The night before, I write three stories...", "Practical", "Tutorial", ["Work & money"], "photo_text"),
  ("Kids explain the news", "Today's topic: elections", "", "So you pick the person you like most...", "Entertainment", "Skit", ["News & society"], "video"),
  ("Miracle tea: lose 10kg in a week", "Order now, link in bio", "-10KG", "This tea melts fat while you sleep...", "Ecosystem issue", "Review", ["Health & fitness"], "photo_text"),
  ("Should games cost 80 euros?", "Prices keep going up. Where's the line for you?", "", "Let's talk about the new price...", "Discussion", "Vlog", ["Games", "Work & money"], "video"),
  ("Weekend in Seville on a budget", "Everything we spent, to the euro.", "€146 TOTAL", "Day one, we got the early train...", "Practical", "Vlog", ["Travel", "Work & money"], "video"),
  ("Dog tricks in 60 seconds", "Teach 'spin' in a day.", "TRICK 1", "Hold the treat by his nose...", "Practical", "Tutorial", ["Pets & animals"], "video"),
]

FIRST = ["mia", "leo", "sara", "tom", "ana", "kai", "noa", "eli", "ivy", "max", "zoe", "ben"]
SECOND = ["kitchen", "travels", "daily", "tech", "home", "fit", "games", "money", "style", "pets"]
COUNTRIES = [("ES", "Spanish"), ("PT", "Portuguese"), ("GB", "English"), ("DE", "German"), ("FR", "French"), ("IT", "Italian")]

def frames(i, n):
    return [f"sample-data/img/frame-{(i + k) % 8 + 1}.svg" for k in range(n)]

examples, labels = [], []
idx = 0
for rep in range(2):
    for p in POSTS:
        title, desc, ocr, asr, pv, fmt, topics, typ = p
        if rep == 1:
            title = title + (" (part 2)" if typ == "video" else " · update")
        idx += 1
        ext = f"{7340000000 + idx * 7919}"
        name = f"{random.choice(FIRST)}.{random.choice(SECOND)}"
        cc, lang = random.choice(COUNTRIES)
        feats = {
            "Description": desc,
            "OCR_Text": ocr,
            "ASR": asr if typ == "video" or random.random() < 0.4 else "",
            "Cover": f"sample-data/img/frame-{idx % 8 + 1}.svg",
            "Creator_Nick_Name": name,
            "Creator_Bio": random.choice(["Honest reviews", "Daily life, mostly", "Tips that work", "Just for fun", "", "Opinions are my own"]),
            "Creator_Avatar": "sample-data/img/avatar.svg",
            "Hashtags": " ".join("#" + t.split(" ")[0].lower() for t in topics),
            "Create_Time": f"2026-10-{(idx % 27) + 1:02d} {(idx * 7) % 24:02d}:{(idx * 13) % 60:02d}",
            "Country_Code": cc,
            "POI_Name": "",
            "POI_Info": "",
            "Interest_V3": topics[0],
            "Language": lang,
            "Intelligence_POI": "",
            "Summary": "",
            "Effective_Info": "",
        }
        if typ == "video":
            feats["Frame"] = frames(idx, 4)
        else:
            feats["Title"] = title
            feats["Images"] = frames(idx, 2)
        examples.append({"externalId": ext, "type": typ, "title": title, "features": feats})
        labels.append({"externalId": ext, "answer": {"primary_value": [pv], "format": [fmt], "topics": topics}})

for i in range(1, 9):
    shade = 200 + (i * 6) % 40
    open(os.path.join(OUT, "img", f"frame-{i}.svg"), "w").write(
        f'<svg xmlns="http://www.w3.org/2000/svg" width="180" height="320" viewBox="0 0 180 320"><rect width="180" height="320" fill="rgb({shade},{shade},{shade})"/><text x="90" y="166" font-family="sans-serif" font-size="14" fill="#555" text-anchor="middle">Frame {i}</text></svg>')
open(os.path.join(OUT, "img", "avatar.svg"), "w").write(
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><circle cx="32" cy="32" r="32" fill="#d4d4d4"/></svg>')
json.dump({"note": "Made-up examples for the stand-ins. Not real data.", "examples": examples, "labels": labels},
          open(os.path.join(OUT, "examples.json"), "w"), ensure_ascii=False, indent=1)
print(len(examples), "examples")
