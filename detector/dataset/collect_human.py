"""Collect pre-ChatGPT human articles on image topics from the Wayback Machine (snapshots 2018 to mid-2021).
For each site, CDX lists archived article URLs whose path matches the topic words; up to PER_SITE are fetched and
reduced to main text with trafilatura. Output: human_web/<name>.txt, first line "<timestamp> <url>"."""
import json, os, re, sys, time, urllib.request, urllib.parse
import trafilatura

D = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
OUT = os.path.join(D, "human_calc" if len(sys.argv) > 2 and sys.argv[2] == "calc" else "human_web")
os.makedirs(OUT, exist_ok=True)
PER_SITE = int(sys.argv[1]) if len(sys.argv) > 1 else 8
MODE = sys.argv[2] if len(sys.argv) > 2 else "image"
TOPIC_IMAGE = r".*(image|photo|picture|jpe?g|png|gif|webp|heic|exif|metadata|compress|resiz|screenshot|upload|imgur|instagram|thumbnail|banner|wallpaper|camera|pixel|resolution|crop).*"
# Topics of the calculator pages (finance, math, home and garden, business, health, science, education, cars, dates,
# sport, pregnancy, unit conversion), so human text on those subjects is in the set too and the model can't learn
# "finance or cars = AI" from the calculator drafts.
TOPIC_CALC = r".*(calculat|mortgage|loan|interest|retire|budget|salary|tax|invest|savings|inflation|percent|fraction|ratio|average|area|volume|square-feet|concrete|paint|garden|fertiliz|lawn|tile|flooring|profit|margin|markup|bmi|calorie|body-fat|heart-rate|pregnan|due-date|ovulat|gpa|grade|horsepower|torque|fuel|mpg|gas-mileage|speed|distance|pace|convert|conversion|celsius|fahrenheit|age|days-between|time-zone|probability|density|velocity|energy).*"
TOPIC = TOPIC_CALC if MODE == "calc" else TOPIC_IMAGE
SKIP = re.compile(r"(/tag/|/category/|/author/|/page/\d|/feed|\?|#|/amp/?$|/comment|/wp-content/|\.(jpe?g|png|gif|webp|pdf|xml|css|js)$|/gallery/|/videos?/)", re.I)
SITES_IMAGE = """howtogeek.com lifewire.com makeuseof.com digitaltrends.com techradar.com pcworld.com cnet.com zapier.com
petapixel.com digital-photography-school.com photographylife.com expertphotography.com smashingmagazine.com css-tricks.com
wpbeginner.com kinsta.com sproutsocial.com blog.hootsuite.com buffer.com shopify.com blog.hubspot.com wikihow.com
guidingtech.com techjunkie.com alphr.com laptopmag.com tomsguide.com imore.com androidauthority.com androidcentral.com
fstoppers.com diyphotography.net shotkit.com format.com/magazine 99designs.com webdesignerdepot.com sitepoint.com
elegantthemes.com wpexplorer.com themeisle.com dreamhost.com/blog hostinger.com/tutorials neilpatel.com/blog
searchenginejournal.com searchengineland.com moz.com/blog backlinko.com later.com/blog tailwindapp.com/blog
makeuseof.com/tag nytimes.com/wirecutter theverge.com engadget.com zdnet.com/article pcmag.com/how-to macworld.com
groovypost.com addictivetips.com ghacks.net online-tech-tips.com helpdeskgeek.com techrepublic.com/article
""".split()
SITES_CALC = """calculator.net investopedia.com nerdwallet.com bankrate.com thebalance.com fool.com
edmunds.com caranddriver.com cars.com healthline.com verywellfit.com verywellhealth.com mayoclinic.org
webmd.com whattoexpect.com babycenter.com thespruce.com bobvila.com familyhandyman.com homedepot.com/c
gardeningknowhow.com almanac.com khanacademy.org mathsisfun.com purplemath.com thoughtco.com
physicsclassroom.com sciencing.com runnersworld.com active.com timeanddate.com rapidtables.com
inchcalculator.com omnicalculator.com calculatorsoup.com wikihow.com entrepreneur.com shopify.com/blog
""".split()
SITES = SITES_CALC if MODE == "calc" else SITES_IMAGE
if len(sys.argv) > 3 and sys.argv[3] == "rev":  # a second process can work from the other end of the list
    SITES = SITES[::-1]

UA = {"User-Agent": "Mozilla/5.0 (research; pre-2022 corpus)"}


def get(url, timeout=60, tries=3):
    for a in range(tries):
        try:
            return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout).read()
        except Exception as e:
            if a == tries - 1:
                raise
            time.sleep(10 * (a + 1))


def cdx(site):
    q = ("https://web.archive.org/cdx/search/cdx?" + urllib.parse.urlencode({
        "url": site + "/*", "from": "2018", "to": "20210630", "output": "json", "fl": "timestamp,original",
        "filter": ["statuscode:200", "mimetype:text/html", "original:" + TOPIC], "collapse": "urlkey", "limit": "400"}, doseq=True))
    try:
        rows = json.loads(get(q, 120) or b"[]")
    except Exception as e:
        print("cdx-fail", site, str(e)[:60], flush=True)
        return []
    return [(t, u) for t, u in rows[1:] if not SKIP.search(u) and u.count("/") >= 4]


total = 0
for site in SITES:
    have = sum(1 for f in os.listdir(OUT) if f.startswith(re.sub(r"[^a-z0-9]+", "_", site.split("/")[0])))
    if have >= PER_SITE:
        continue
    cands = cdx(site)
    # prefer longer, article-like slugs
    cands.sort(key=lambda x: -len(x[1].rstrip("/").rsplit("/", 1)[-1]))
    got = have
    for ts, u in cands:
        if got >= PER_SITE:
            break
        clean = re.sub(r"^https?://", "", u).replace(":80/", "/")
        name = re.sub(r"[^a-z0-9]+", "_", clean.lower()).strip("_")[:110] + ".txt"
        p = os.path.join(OUT, name)
        if os.path.exists(p):
            continue
        time.sleep(2)
        try:
            html = get(f"https://web.archive.org/web/{ts}id_/{u}").decode("utf-8", "ignore")
            text = trafilatura.extract(html, include_comments=False, include_tables=False, favor_precision=True) or ""
        except Exception as e:
            continue
        n = len(text.split())
        if n < 400 or n > 6000:
            continue
        open(p, "w", encoding="utf-8").write(f"{ts} {u}\n{text}")
        got += 1
        total += 1
    print("site", site, "candidates", len(cands), "saved", got - have, flush=True)
print("TOTAL new", total, "files", len(os.listdir(OUT)))
