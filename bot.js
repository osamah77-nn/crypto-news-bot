const fs = require("fs");
const path = require("path");
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");

const TELEGRAM_BOT_TOKEN = "8765790798:AAHDmF5zPH6QHF7WIrYsZxjpwU3-0IGyDnU";
const TELEGRAM_CHAT_ID = "-1003964962757";
const RSS_FEEDS = [
  "https://cointelegraph.com/rss",
  "https://www.coindesk.com/arc/outboundfeeds/rss/",
  "https://decrypt.co/feed",
  "https://bitcoinmagazine.com/.rss/full/",
];
const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const DESCRIPTION_MAX_LENGTH = 250;
const MAX_NEWS_PER_CHECK = 3;
const TRANSLATE_API_URL = "https://api.mymemory.translated.net/get";
const TRANSLATION_RETRY_COUNT = 3;
const TRANSLATION_RETRY_DELAY_MS = 5000;
const ENGLISH_LETTERS_THRESHOLD = 20;
const ENGLISH_WORDS_THRESHOLD = 4;
const SENT_NEWS_FILE = path.join(__dirname, "sent_news.json");
const CTA_PROBABILITY = 0.4;
const HEADLINE_ONLY_PROBABILITY = 0.3;
const POSITIVE_KEYWORDS = [
  "rise",
  "surge",
  "gain",
  "bullish",
  "up",
  "ارتفاع",
  "صعود",
  "مكاسب",
];
const NEGATIVE_KEYWORDS = [
  "fall",
  "drop",
  "crash",
  "loss",
  "bearish",
  "هبوط",
  "خسارة",
  "انخفاض",
];
const NEWS_INTROS = [
  "📰 تحديث جديد من سوق الكريبتو",
  "⚡ خبر عاجل في العملات الرقمية",
  "📊 حركة جديدة في سوق العملات",
  "🚀 متابعة سريعة من عالم الكريبتو",
  "🔔 تنبيه جديد للمستثمرين",
  "📌 خبر مهم من سوق العملات الرقمية",
];
const CTA_LINES = [
  "🔔 تابع القناة ليصلك كل جديد",
  "📢 شارك الخبر مع المهتمين بالكريبتو",
  "⚡ فعّل التنبيهات ولا تفوت تحديثات السوق",
  "💬 شاركنا رأيك حول هذا الخبر",
];

const sentNews = new Set();
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN);

function decodeXmlEntities(text) {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function extractTagValue(block, tagName) {
  const pattern = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i");
  const match = block.match(pattern);
  return match ? decodeXmlEntities(match[1].trim()) : "";
}

function extractAttributeValue(block, tagName, attributeName) {
  const pattern = new RegExp(
    `<${tagName}\\b[^>]*${attributeName}=["']([^"']+)["'][^>]*>`,
    "i"
  );
  const match = block.match(pattern);
  return match ? decodeXmlEntities(match[1].trim()) : "";
}

function stripHtmlTags(text) {
  return text
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateText(text, maxLength) {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 3).trim()}...`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function countRegexMatches(text, pattern) {
  return (text.match(pattern) || []).length;
}

function hasArabicLetters(text) {
  return /[\u0600-\u06FF]/.test(text || "");
}

function hasTooManyEnglishLetters(text) {
  if (!text) {
    return false;
  }

  const englishLettersCount = countRegexMatches(text, /[A-Za-z]/g);
  const englishWordsCount = countRegexMatches(text, /\b[A-Za-z]{4,}\b/g);

  return (
    englishLettersCount >= ENGLISH_LETTERS_THRESHOLD ||
    englishWordsCount >= ENGLISH_WORDS_THRESHOLD
  );
}

function normalizeTextForComparison(text) {
  return (text || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function isValidArabicTranslation(originalText, translatedText) {
  const normalizedTranslatedText = normalizeTextForComparison(translatedText);

  if (!normalizedTranslatedText) {
    return false;
  }

  if (!hasArabicLetters(translatedText)) {
    return false;
  }

  if (hasTooManyEnglishLetters(translatedText)) {
    return false;
  }

  const normalizedOriginalText = normalizeTextForComparison(originalText);
  const originalContainsEnglish = /[A-Za-z]/.test(originalText || "");

  if (
    originalContainsEnglish &&
    normalizedOriginalText &&
    normalizedTranslatedText === normalizedOriginalText
  ) {
    return false;
  }

  return true;
}

function extractImageUrl(item) {
  const tagSources = [
    () => extractAttributeValue(item, "enclosure", "url"),
    () => extractAttributeValue(item, "media:content", "url"),
    () => extractAttributeValue(item, "media:thumbnail", "url"),
    () => extractAttributeValue(item, "img", "src"),
  ];

  for (const getImageUrl of tagSources) {
    const imageUrl = getImageUrl();
    if (imageUrl) {
      return imageUrl;
    }
  }

  const rawDescription =
    extractTagValue(item, "description") || extractTagValue(item, "content:encoded");
  const imageMatch = rawDescription.match(/<img\b[^>]*src=["']([^"']+)["']/i);
  return imageMatch ? decodeXmlEntities(imageMatch[1].trim()) : "";
}

function extractDescription(item) {
  const rawDescription =
    extractTagValue(item, "description") ||
    extractTagValue(item, "summary") ||
    extractTagValue(item, "content:encoded");

  const cleanedDescription = stripHtmlTags(decodeXmlEntities(rawDescription));

  if (!cleanedDescription) {
    return "لا توجد تفاصيل إضافية متاحة حالياً.";
  }

  return truncateText(cleanedDescription, DESCRIPTION_MAX_LENGTH);
}

function extractPublishedAt(item) {
  const rawDate =
    extractTagValue(item, "pubDate") ||
    extractTagValue(item, "published") ||
    extractTagValue(item, "updated") ||
    extractTagValue(item, "dc:date");

  const timestamp = Date.parse(rawDate);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function getArticleKey(article) {
  return (article.link || article.title || "").trim().toLowerCase();
}

function dedupeArticles(articles) {
  const uniqueArticles = [];
  const seenKeys = new Set();

  for (const article of articles) {
    const articleKey = getArticleKey(article);

    if (!articleKey || seenKeys.has(articleKey)) {
      continue;
    }

    seenKeys.add(articleKey);
    uniqueArticles.push(article);
  }

  return uniqueArticles;
}

function parseRssFeed(xml, sourceUrl) {
  const items = xml.match(/<item\b[\s\S]*?<\/item>/gi) || [];

  return items
    .map((item) => {
      const title = extractTagValue(item, "title");
      const link = extractTagValue(item, "link");
      const description = extractDescription(item);
      const imageUrl = extractImageUrl(item);
      const publishedAt = extractPublishedAt(item);

      return {
        title,
        link,
        description,
        imageUrl,
        publishedAt,
        sourceUrl,
      };
    })
    .filter((article) => article.title || article.link);
}

function sortArticlesByDate(articles) {
  return [...articles].sort((firstArticle, secondArticle) => {
    return secondArticle.publishedAt - firstArticle.publishedAt;
  });
}

function getRandomItem(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function getNewsEmoji(article) {
  const normalizedTitle = `${article.title || ""} ${article.translatedTitle || ""}`.toLowerCase();

  if (POSITIVE_KEYWORDS.some((keyword) => normalizedTitle.includes(keyword))) {
    return "🟢📈🚀";
  }

  if (NEGATIVE_KEYWORDS.some((keyword) => normalizedTitle.includes(keyword))) {
    return "🔴📉⚠️";
  }

  return "🟡📰";
}

function buildNewsMessage(article) {
  const emoji = getNewsEmoji(article);
  const title = article.translatedTitle || article.title || "خبر جديد";
  const description = article.translatedDescription || article.description;
  const lines = [];

  if (Math.random() < HEADLINE_ONLY_PROBABILITY) {
    lines.push(`${emoji} ${title}`);
  } else {
    lines.push(`${emoji} ${getRandomItem(NEWS_INTROS)}`);
    lines.push("");
    lines.push(title);
  }

  lines.push("");
  lines.push(description);

  if (Math.random() < CTA_PROBABILITY) {
    lines.push("");
    lines.push(getRandomItem(CTA_LINES));
  }

  return lines.join("\n");
}

async function ensureStateFile() {
  try {
    await fs.promises.access(SENT_NEWS_FILE, fs.constants.F_OK);
  } catch {
    await fs.promises.writeFile(SENT_NEWS_FILE, "[]", "utf8");
  }
}

async function loadSentNews() {
  await ensureStateFile();

  try {
    const rawData = await fs.promises.readFile(SENT_NEWS_FILE, "utf8");
    const storedKeys = JSON.parse(rawData);

    if (Array.isArray(storedKeys)) {
      for (const key of storedKeys) {
        if (typeof key === "string" && key.trim()) {
          sentNews.add(key.trim().toLowerCase());
        }
      }
    }

    console.log(`[state] تم تحميل ${sentNews.size} خبر محفوظ من sent_news.json.`);
  } catch (error) {
    console.log("[state] تعذر قراءة ملف الحالة، سيتم إعادة تهيئته:", error.message);
    await fs.promises.writeFile(SENT_NEWS_FILE, "[]", "utf8");
    sentNews.clear();
  }
}

async function saveSentNews() {
  try {
    await fs.promises.writeFile(
      SENT_NEWS_FILE,
      JSON.stringify([...sentNews], null, 2),
      "utf8"
    );
  } catch (error) {
    console.error("[state] فشل تحديث sent_news.json:", error.message);
  }
}

async function markArticleAsSent(article) {
  const articleKey = getArticleKey(article);

  if (!articleKey || sentNews.has(articleKey)) {
    return;
  }

  sentNews.add(articleKey);
  await saveSentNews();
}

async function markArticlesAsSent(articles) {
  let hasNewKeys = false;

  for (const article of articles) {
    const articleKey = getArticleKey(article);

    if (!articleKey || sentNews.has(articleKey)) {
      continue;
    }

    sentNews.add(articleKey);
    hasNewKeys = true;
  }

  if (hasNewKeys) {
    await saveSentNews();
  }
}

async function translateText(text, fieldName, articleLabel) {
  if (!text) {
    return null;
  }

  for (let attempt = 1; attempt <= TRANSLATION_RETRY_COUNT; attempt += 1) {
    try {
      const response = await axios.get(TRANSLATE_API_URL, {
        timeout: 15000,
        params: {
          q: text,
          langpair: "en|ar",
        },
      });

      const translatedText = response.data?.responseData?.translatedText?.trim();

      if (isValidArabicTranslation(text, translatedText)) {
        return translatedText;
      }

      console.log(
        `[translate] ترجمة ${fieldName} غير صالحة للمقال "${articleLabel}" في المحاولة ${attempt}.`
      );
  } catch (error) {
    console.log("[translate] فشلت الترجمة، سيتم استخدام النص الأصلي:", error.message);
      console.log(
        `[translate] فشلت ترجمة ${fieldName} للمقال "${articleLabel}" في المحاولة ${attempt}: ${error.message}`
      );
    }

    if (attempt < TRANSLATION_RETRY_COUNT) {
      await sleep(TRANSLATION_RETRY_DELAY_MS);
    }
  }

  return null;
}

async function translateArticle(article) {
  const articleLabel = article.title || article.link || "بدون عنوان";
  const requiredTranslatedTitle = await translateText(
    article.title,
    "العنوان",
    articleLabel
  );
  const requiredTranslatedDescription = await translateText(
    article.description,
    "الوصف",
    articleLabel
  );

  if (!requiredTranslatedTitle || !requiredTranslatedDescription) {
    return null;
  }

  return {
    ...article,
    translatedTitle: requiredTranslatedTitle,
    translatedDescription: requiredTranslatedDescription,
  };

  const translatedTitle = await translateText(article.title);
  const translatedDescription = await translateText(article.description);

  return {
    ...article,
    translatedTitle,
    translatedDescription,
  };
}

async function sendTextMessage(message) {
  try {
    await bot.sendMessage(TELEGRAM_CHAT_ID, message);
    return true;
  } catch (error) {
    console.error("[telegram] فشل إرسال الرسالة النصية:", error.message);
    return false;
  }
}

async function sendArticle(article) {
  const preparedArticle = await translateArticle(article);

  if (!preparedArticle) {
    console.log(`[translate] تم تخطي الخبر بسبب فشل الترجمة: ${article.title || article.link}`);
    return null;
  }

  const preparedMessage = buildNewsMessage(preparedArticle);

  if (hasTooManyEnglishLetters(preparedMessage)) {
    console.log(
      `[translate] تم تخطي الخبر بسبب احتوائه على نص إنجليزي بعد الترجمة: ${article.title || article.link}`
    );
    return null;
  }

  if (preparedArticle.imageUrl) {
    try {
      await bot.sendPhoto(TELEGRAM_CHAT_ID, preparedArticle.imageUrl, {
        caption: preparedMessage,
      });
      return true;
    } catch (error) {
      console.error("[telegram] فشل إرسال الصورة، سيتم الإرسال كنص:", error.message);
    }
  }

  return sendTextMessage(preparedMessage);

  const translatedArticle = await translateArticle(article);
  const message = buildNewsMessage(translatedArticle);

  if (translatedArticle.imageUrl) {
    try {
      await bot.sendPhoto(TELEGRAM_CHAT_ID, translatedArticle.imageUrl, {
        caption: message,
      });
      return true;
    } catch (error) {
      console.error("[telegram] فشل إرسال الصورة، سيتم الإرسال كنص:", error.message);
    }
  }

  return sendTextMessage(message);
}

async function fetchFeedArticles(feedUrl) {
  try {
    const response = await axios.get(feedUrl, {
      timeout: 15000,
      headers: {
        "User-Agent": "crypto-news-bot/1.0",
      },
    });

    console.log(`[news] تم جلب الأخبار من المصدر: ${feedUrl}`);
    return parseRssFeed(response.data, feedUrl);
  } catch (error) {
    console.error(`[news] فشل جلب الأخبار من المصدر ${feedUrl}:`, error.message);
    return [];
  }
}

async function fetchCryptoNews() {
  const feedResults = await Promise.all(
    RSS_FEEDS.map((feedUrl) => fetchFeedArticles(feedUrl))
  );
  const allArticles = feedResults.flat();
  const uniqueArticles = dedupeArticles(allArticles);
  const sortedArticles = sortArticlesByDate(uniqueArticles);

  console.log(`[news] تم دمج ${sortedArticles.length} خبر من جميع المصادر.`);
  return sortedArticles;
}

async function seedCurrentArticles() {
  const articles = await fetchCryptoNews();
  await markArticlesAsSent(articles);
  console.log(`[news] تم تجهيز ${sentNews.size} خبر حالي دون إرسال أخبار قديمة.`);
}

async function checkForNewArticles() {
  const articles = await fetchCryptoNews();
  const newArticles = articles
    .filter((article) => !sentNews.has(getArticleKey(article)))
    .slice(0, MAX_NEWS_PER_CHECK);

  if (newArticles.length === 0) {
    console.log("[news] لا توجد أخبار جديدة حاليًا.");
    return;
  }

  for (const article of newArticles) {
    const sent = await sendArticle(article);

    if (sent === true) {
      await markArticleAsSent(article);
      console.log(`[telegram] تم إرسال خبر جديد: ${article.title}`);
      continue;
    }

    if (sent === null) {
      await markArticleAsSent(article);
      continue;
    }

    console.error(`[telegram] تعذر إرسال الخبر: ${article.title}`);
  }

  return;

  for (const article of newArticles) {
    const sent = await sendArticle(article);

    if (sent) {
      await markArticleAsSent(article);
      console.log(`[telegram] تم إرسال خبر جديد: ${article.title}`);
    } else {
      console.error(`[telegram] تعذر إرسال الخبر: ${article.title}`);
    }
  }
}

async function startBot() {
  await loadSentNews();

  const startupMessage = `👋 مرحباً عدنا لكم

🚀 نتابع معكم آخر أخبار سوق العملات الرقمية لحظة بلحظة`;
  const startupSent = await sendTextMessage(startupMessage);

  if (startupSent) {
    console.log("[startup] تم إرسال رسالة الترحيب بنجاح.");
  }

  await seedCurrentArticles();

  console.log("[startup] البوت يعمل الآن وسيفحص أخبار العملات الرقمية كل 5 دقائق.");

  setInterval(() => {
    checkForNewArticles().catch((error) => {
      console.error("[news] خطأ غير متوقع أثناء فحص الأخبار:", error.message);
    });
  }, CHECK_INTERVAL_MS);
}

startBot().catch((error) => {
  console.error("[startup] فشل تشغيل البوت:", error.message);
});
