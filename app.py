"""英语零基础 · 句子学堂 —— Flask 后端

路由：
  GET  /               渲染主页
  GET  /api/sentences  返回全部句子（内置 + 用户生成）
  POST /api/generate   调 DeepSeek 按等级生成新句子，写入 data/user_sentences.json
  POST /api/quiz       根据已学句子 id 生成选择题检测

DeepSeek Key 通过环境变量 ENG_DEEPSEEK_KEY 提供（见 .env.example）。
"""

import os
import json
import time
import random
import threading
import urllib.request
import urllib.error

from flask import Flask, render_template, request, jsonify

# 若项目根目录有 .env，自动加载其中的环境变量（如 ENG_DEEPSEEK_KEY）
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

app = Flask(__name__)

DATA_DIR = os.path.join(app.root_path, "data")
STARTER_FILE = os.path.join(DATA_DIR, "sentences.json")
USER_FILE = os.path.join(DATA_DIR, "user_sentences.json")
DEEPSEEK_URL = "https://api.deepseek.com/chat/completions"


# ---------------- 数据加载 ----------------
def load_starter():
    with open(STARTER_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


def load_user():
    if not os.path.exists(USER_FILE):
        return []
    with open(USER_FILE, "r", encoding="utf-8") as f:
        try:
            return json.load(f)
        except json.JSONDecodeError:
            return []


_user_lock = threading.Lock()


def save_user(lst):
    # 多用户并发写入同一文件时加锁，避免内容被截断/损坏
    with _user_lock:
        tmp = USER_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(lst, f, ensure_ascii=False, indent=2)
        os.replace(tmp, USER_FILE)


def all_sentences():
    return load_starter() + load_user()


# ---------------- DeepSeek 生成 ----------------
def call_deepseek(level, count, scenario=None):
    key = os.environ.get("ENG_DEEPSEEK_KEY")
    if not key:
        raise ValueError("未配置 DeepSeek API Key（环境变量 ENG_DEEPSEEK_KEY）")

    system = (
        "你是面向中文母语零基础成人的英语老师。请生成简单、生活化、语法正确的英语句子及逐词解析。"
        "严格只返回一个 JSON 对象，格式："
        '{"sentences":[{"text":"完整句子(结尾加英文句号)","words":['
        '{"w":"单词","zh":"中文释义","py":"中文谐音(用常见汉字模拟发音,如 bus→霸死)","ipa":"国际音标"}]}]}。'
        "谐音只需帮助联想记忆，不必标准；音标可留空字符串。不要输出任何解释文字。"
    )
    scenario_hint = ("场景：" + scenario + "。") if scenario else "场景：日常通用交流。"
    user = (
        "请生成 " + str(count) + " 个等级 " + str(level) + " 的英语句子，属于「" + scenario_hint + "」"
        "等级说明：1=2-5词超短句，2=5-7词短句，3=7-9词中句，4=9-11词较长句，5=11词以上长句。"
        "只返回 JSON。"
    )

    payload = {
        "model": "deepseek-chat",
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "response_format": {"type": "json_object"},
        "temperature": 0.8,
    }
    req = urllib.request.Request(
        DEEPSEEK_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + key,
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = json.loads(resp.read().decode("utf-8"))

    content = data["choices"][0]["message"]["content"]
    parsed = json.loads(content)
    return parsed.get("sentences", [])


# ---------------- 测验生成 ----------------
def pick_distractors(pool, correct, key, n):
    """从 pool 中取 n 个与 correct[key] 不同、且彼此不同的取值。"""
    out, seen = [], set()
    for d in pool:
        v = d[key]
        if v == correct[key] or v in seen:
            continue
        seen.add(v)
        out.append(v)
    random.shuffle(out)
    return out[:n]


def build_quiz(learned_ids):
    all_s = all_sentences()
    wanted = set(learned_ids)
    learned = [s for s in all_s if s["id"] in wanted]

    # 候选 (sentence_id, sentence_text, word_dict)，按词去重避免同一词重复出题
    candidates = []
    seen_words = set()
    for s in learned:
        for wd in s["words"]:
            if wd["w"] in seen_words:
                continue
            seen_words.add(wd["w"])
            candidates.append((s["id"], s["text"], wd))
    if not candidates:
        return []

    # 干扰项词池（按 w 去重）
    pool = {}
    for s in all_s:
        for wd in s["words"]:
            pool.setdefault(wd["w"], wd)
    pool_list = list(pool.values())

    random.shuffle(candidates)
    questions = []
    types = ["meaning", "reverse", "listen"]
    for i, (sid, stext, wd) in enumerate(candidates[:6]):
        t = types[i % len(types)]
        if t == "meaning":
            correct = wd["zh"]
            opts = pick_distractors(pool_list, wd, "zh", 3)
            options = opts + [correct]
            random.shuffle(options)
            questions.append({
                "type": t,
                "prompt": "“" + wd["w"] + "” 的意思是？",
                "options": options,
                "answer": correct,
                "sentence_id": sid,
                "sentence_text": stext,
            })
        elif t == "reverse":
            correct = wd["w"]
            opts = pick_distractors(pool_list, wd, "w", 3)
            options = opts + [correct]
            random.shuffle(options)
            questions.append({
                "type": t,
                "prompt": "“" + wd["zh"] + "” 对应的英文是？",
                "options": options,
                "answer": correct,
                "sentence_id": sid,
                "sentence_text": stext,
            })
        else:  # listen
            correct = wd["w"]
            opts = pick_distractors(pool_list, wd, "w", 3)
            options = opts + [correct]
            random.shuffle(options)
            questions.append({
                "type": t,
                "prompt": "🔊 听到的单词是？",
                "audio": wd["w"],
                "options": options,
                "answer": correct,
                "sentence_id": sid,
                "sentence_text": stext,
            })
    return questions


# ---------------- 路由 ----------------
@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/sentences")
def api_sentences():
    return jsonify(all_sentences())


@app.route("/api/generate", methods=["POST"])
def api_generate():
    body = request.get_json(silent=True) or {}
    level = int(body.get("level", 1))
    count = int(body.get("count", 5))
    scenario = body.get("scenario") or "日常"
    try:
        generated = call_deepseek(level, count, scenario)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        return jsonify({"error": "生成失败：" + str(e)}), 502

    if not generated:
        return jsonify({"error": "DeepSeek 返回为空"}), 502

    stamp = str(int(time.time() * 1000))
    user_s = load_user()
    for i, s in enumerate(generated):
        if not s.get("words"):
            continue
        s["id"] = "gen-" + stamp + "-" + str(i)
        s["level"] = level
        s["scenario"] = scenario
        user_s.append(s)
    save_user(user_s)
    return jsonify({"sentences": generated, "total": len(user_s)})


@app.route("/api/quiz", methods=["POST"])
def api_quiz():
    body = request.get_json(silent=True) or {}
    learned_ids = body.get("learned_ids", [])
    questions = build_quiz(learned_ids)
    return jsonify({"questions": questions})


if __name__ == "__main__":
    # 生产环境通过环境变量覆盖：PORT（监听端口）、FLASK_DEBUG=0（关闭调试）
    PORT = int(os.environ.get("PORT", 5000))
    DEBUG = os.environ.get("FLASK_DEBUG", "1") == "1"
    app.run(host="0.0.0.0", port=PORT, debug=DEBUG)
