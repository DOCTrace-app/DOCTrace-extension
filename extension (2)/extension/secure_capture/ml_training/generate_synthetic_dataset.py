"""
Generate a synthetic privacy dataset of FAKE examples.

Output: data/synthetic_privacy_dataset.csv  with columns  text,label
    label 1 = sensitive (value that must be hidden)
    label 0 = normal UI / non-sensitive text

Why synthetic? Google Screen Annotation and ENRICO have no labels for
password / API key / CNIC / PII. So we create fake sensitive values here,
and use the real UI datasets only as extra NON-sensitive text
(see prepare_ui_datasets.py).

Rule for labels: a label on its own ("Password", "Email") is 0.
A value ("MySecret123") or label + value ("Password: MySecret123") is 1.

Run:  python generate_synthetic_dataset.py
"""
import csv
import random
import string
from pathlib import Path

SEED = 42
N_PER_GENERATOR = 70
OUT = Path(__file__).resolve().parent / "data" / "synthetic_privacy_dataset.csv"

rng = random.Random(SEED)

# The examples given in the project brief. Always included.
SEED_ROWS = [
    ("Welcome to Dashboard", 0), ("Settings", 0), ("Login", 0),
    ("Total Sales: $10000", 0), ("maryam@example.com", 1),
    ("03001234567", 1), ("35202-1234567-8", 1), ("MySecret123", 1),
    ("ABC123XYZ", 1), ("API_KEY: ABC123XYZ", 1), ("Password: MySecret123", 1),
]

FIRST = ["maryam", "ali", "sara", "ahmed", "fatima", "usman", "ayesha", "bilal",
         "hina", "omar", "zainab", "hamza", "john", "emma", "lucas", "mia", "noah", "test.user"]
LAST = ["khan", "raza", "malik", "ahmed", "butt", "sheikh", "iqbal", "smith", "doe", "brown"]
FAKE_DOMAINS = ["example.com", "example.org", "example.net", "test.com", "mail.test", "demo.pk"]
WORDS = ["secret", "summer", "winter", "dragon", "sunshine", "monkey", "pakistan",
         "lahore", "karachi", "admin", "qwerty", "letmein", "football", "welcome"]
LABEL_SEP = [": ", ":", " = ", "=", " - ", " "]

UI_TEXT = """Home|Dashboard|Settings|Login|Logout|Sign in|Sign up|Sign out|Register|Profile|Account|
Reports|Help|Search|Save|Cancel|Submit|Delete|Edit|Update|Next|Back|Previous|Continue|Close|Open|
File|View|Insert|Format|Tools|Window|New Tab|Bookmarks|History|Downloads|Extensions|Share|Export|
Import|Upload|Download|Print|Refresh|Reload|Apply|Reset filters|Filter|Sort by|Show more|Show less|
Notifications|Messages|Inbox|Sent|Drafts|Trash|Archive|Calendar|Contacts|Tasks|Projects|Team|
Members|Invite|Billing|Plans|Pricing|Support|Documentation|Privacy Policy|Terms of Service|
About us|Contact us|Welcome back|Welcome to Dashboard|Getting started|Overview|Analytics|
Revenue|Sales|Orders|Customers|Products|Inventory|Invoices|Payments|Transactions|Status|
Active|Inactive|Pending|Completed|Failed|Approved|Rejected|Draft|Published|Today|Yesterday|
This week|Last month|All time|Language|English|Urdu|Theme|Light|Dark|System default|
Remember me|Forgot password?|Reset password|Change password|Show password|Hide password|
Create account|Already have an account?|Don't have an account?|Terms and conditions|
I agree|Accept|Decline|Allow|Block|Enable|Disable|On|Off|Yes|No|OK|Done|Loading...|
Please wait|Something went wrong|Try again|No results found|Page not found|Untitled|
Add new|Add item|Remove|Duplicate|Rename|Move to|Copy link|Paste|Undo|Redo|Zoom in|Zoom out|
Quality Assurance|Engineering|Marketing|Human Resources|Finance|Operations|Lahore|Karachi|
Islamabad|Berlin|Pakistan|Germany|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|
January|February|March|April|May|June|July|August|September|October|November|December|
Chrome|Google|Scribe|Recording|Start recording|Stop recording|Step 1|Click here|Type your message|
Enter your email|Enter your password|Enter your phone number|Your password must be 8 characters|
Password strength: strong|Two-factor authentication|Security settings|Privacy settings|
API documentation|Generate API key|Manage tokens|Token expired|Session expired|Secret Santa party|
Email|Password|Phone|Mobile|CNIC|API Key|Token|Username|Full name|Address|City|Country|
Date of birth|Card number|Expiry date|Confirm password|New password|Current password"""
UI_TEXT = [t.strip() for t in UI_TEXT.replace("\n", "").split("|") if t.strip()]

SENTENCES = [
    "Click {x} to continue", "Your changes have been saved", "You have {n} new messages",
    "Last updated {d}", "Showing {n} of {m} results", "Orders this week: {n}",
    "Step {n} of {m}", "Page {n} of {m}", "Uploaded {n} files", "{n} items selected",
    "Click Settings to change your preferences.", "Welcome back to {x}",
    "Open the {x} menu and select {y}", "Meeting at {t} on {d}", "Version {v}",
    "Storage used: {n} GB of {m} GB", "Progress: {n}%", "Total Sales: ${n}",
    "Balance due: Rs. {n}", "Temperature {n} C", "Room {n}", "Invoice #{n}",
    "Order #{n} shipped", "Qty: {n}", "Price: ${n}.99", "Discount {n}% off",
]


def rand_digits(n):
    return "".join(rng.choice(string.digits) for _ in range(n))


def rand_alnum(n, chars=string.ascii_letters + string.digits):
    return "".join(rng.choice(chars) for _ in range(n))


def date():
    return rng.choice([
        f"{rng.randint(1, 28):02d}/{rng.randint(1, 12):02d}/{rng.randint(2019, 2026)}",
        f"{rng.randint(2019, 2026)}-{rng.randint(1, 12):02d}-{rng.randint(1, 28):02d}",
        f"{rng.randint(1, 28)} {rng.choice(['Jan', 'Feb', 'Mar', 'Oct'])} {rng.randint(2019, 2026)}",
    ])


def clock():
    return f"{rng.randint(1, 12)}:{rng.randint(0, 59):02d} {rng.choice(['AM', 'PM'])}"


# ---------- sensitive value generators (all FAKE) ----------
def email():
    user = rng.choice(FIRST) + rng.choice(["", ".", "_"]) + rng.choice(LAST + [""])
    if rng.random() < 0.5:
        user += str(rng.randint(1, 999))
    return f"{user}@{rng.choice(FAKE_DOMAINS)}"


def phone():
    p = "3" + rand_digits(2)
    n = rand_digits(7)
    return rng.choice([
        f"0{p}{n}", f"0{p}-{n}", f"+92{p}{n}", f"+92 {p} {n}", f"0{p} {n}",
        f"+92-{p}-{n}", f"+1 (555) 01{rand_digits(2)}-{rand_digits(4)}",
        f"+44 20 7946 0{rand_digits(3)}", f"+92 42 {rand_digits(4)} {rand_digits(4)}",
    ])


def cnic():
    a, b, c = rand_digits(5), rand_digits(7), rand_digits(1)
    return rng.choice([f"{a}-{b}-{c}", f"{a}{b}{c}", f"{a} {b} {c}"])


def credit_card():
    # Well known public TEST card numbers, never real cards.
    num = rng.choice(["4111111111111111", "5555555555554444", "4242424242424242",
                      "378282246310005", "6011111111111117", "5105105105105100"])
    if rng.random() < 0.5 and len(num) == 16:
        num = " ".join(num[i:i + 4] for i in range(0, 16, 4))
    return num


def password():
    style = rng.randint(0, 4)
    if style == 0:
        return rng.choice(WORDS).capitalize() + rand_digits(rng.randint(2, 4)) + rng.choice(["", "!", "@", "#"])
    if style == 1:
        return "My" + rng.choice(WORDS).capitalize() + rand_digits(3)
    if style == 2:
        return rand_alnum(rng.randint(8, 16), string.ascii_letters + string.digits + "!@#$%&*")
    if style == 3:
        w = rng.choice(WORDS)
        return w.replace("a", "@").replace("o", "0").replace("s", "$").capitalize() + rand_digits(2)
    return rng.choice(["MySecret123", "P@ssw0rd", "Admin@123", "Qwerty!234", "Welcome#2024"])


def api_key():
    style = rng.randint(0, 7)
    if style == 0:
        return "sk_test_" + rand_alnum(24)
    if style == 1:
        return "AKIA" + rand_alnum(16, string.ascii_uppercase + string.digits)
    if style == 2:
        return "ghp_" + rand_alnum(36)
    if style == 3:
        return rand_alnum(32, "0123456789abcdef")
    if style == 4:
        return "eyJhbGciOiJIUzI1NiJ9." + rand_alnum(20) + "." + rand_alnum(16)
    if style == 5:
        return rand_alnum(3, string.ascii_uppercase) + rand_digits(3) + rand_alnum(3, string.ascii_uppercase)
    if style == 6:
        return "AIza" + rand_alnum(35, string.ascii_letters + string.digits + "_-")
    return rand_alnum(rng.randint(20, 40), string.ascii_letters + string.digits + "_-")


def masked():
    return rng.choice(["*", "\u2022", "\u25cf"]) * rng.randint(6, 14)


LABELLED = [
    (["Password", "password", "PASSWORD", "Pwd", "Passcode", "Confirm Password", "New password"], password),
    (["Password", "Current password"], masked),
    (["API_KEY", "api_key", "API Key", "apikey", "Secret", "SECRET_KEY", "Client Secret",
      "Token", "Access Token", "Auth token", "Private key"], api_key),
    (["Authorization"], lambda: "Bearer " + api_key()),
    (["Email", "E-mail", "Contact", "Email address"], email),
    (["Phone", "Mobile", "Cell", "Tel", "Mobile No"], phone),
    (["CNIC", "CNIC No", "National ID"], cnic),
    (["Card Number", "Credit card", "Card"], credit_card),
]


def labelled_value():
    labels, gen = rng.choice(LABELLED)
    return f"{rng.choice(labels)}{rng.choice(LABEL_SEP)}{gen()}"


# ---------- non-sensitive generators ----------
def sentence():
    return rng.choice(SENTENCES).format(
        x=rng.choice(UI_TEXT), y=rng.choice(UI_TEXT), n=rng.randint(1, 99999),
        m=rng.randint(100, 999), d=date(), t=clock(),
        v=f"{rng.randint(1, 9)}.{rng.randint(0, 20)}.{rng.randint(0, 9)}")


def ui_number():
    return rng.choice([
        f"${rng.randint(1, 99999)}", f"${rng.randint(1, 999)},{rng.randint(100, 999)}.00",
        f"{rng.randint(1, 100)}%", date(), clock(), f"v{rng.randint(1, 9)}.{rng.randint(0, 9)}.{rng.randint(0, 9)}",
        str(rng.randint(1, 9999)), f"{rng.randint(1, 999)} MB", f"{rng.randint(1, 60)}s ago",
        f"{rng.randint(1, 12)}/{rng.randint(1, 12)}", f"#{rng.randint(1, 9999)}", f"({rng.randint(1, 99)})",
        f"Rs. {rng.randint(100, 99999)}", f"{rng.randint(1, 5)}.{rng.randint(0, 9)} stars",
    ])


def ui_word():
    return rng.choice(["www.example.com", "example.com", "https://example.com/docs", "index.html",
                       "report_2024.pdf", "image.png", "main.js", "README.md", "user_settings",
                       "demo_app", "Q3-Report", "COVID-19", "Wi-Fi", "e-mail", "Sign-in",
                       "@username", "#general", "Ctrl+C", "Alt+Tab", "3D", "4K", "5G", "HTML5",
                       "CSS3", "ES2020", "USB-C", "iPhone", "macOS", "Windows 11"])


def label_only():
    # A label with NO value is not sensitive. OCR often returns "Password:"
    # as its own word, so the model must not flag the label itself.
    labels = [l for group, _ in LABELLED for l in group] + ["Username", "User name", "Login ID"]
    label = rng.choice(labels)
    return rng.choice([label, label + ":", label.upper(), label.upper() + ":", label.lower(),
                       f"Enter {label.lower()}", f"{label} *", f"Your {label.lower()}"])


def plain_number():
    # Short numbers are normal UI (counts, prices, IDs). Long digit runs
    # (phone / CNIC / card) are positives and are generated elsewhere.
    return rng.choice([
        str(rng.randint(0, 999999)), str(rng.randint(1000, 9999)), str(rng.randint(1990, 2030)),
        f"{rng.randint(1, 999)},{rng.randint(100, 999)}",
        f"{rng.randint(0, 9999)}.{rng.randint(0, 99):02d}", f"+{rng.randint(1, 99999)}",
        f"-{rng.randint(1, 9999)}", f"{rng.randint(1, 999)}k", f"{rng.randint(10, 99)}-{rng.randint(10, 99)}",
        f"x{rng.randint(1, 99)}", f"{rng.randint(1, 31)}th",
    ])


def main():
    rows = list(SEED_ROWS)
    positives = [email, phone, cnic, credit_card, password, api_key, masked, labelled_value]
    for gen in positives:
        n = N_PER_GENERATOR * (3 if gen is labelled_value else 1)
        rows += [(gen(), 1) for _ in range(n)]
    rows += [(t, 0) for t in UI_TEXT]
    rows += [(rng.choice(UI_TEXT), 0) for _ in range(150)]
    rows += [(sentence(), 0) for _ in range(250)]
    rows += [(ui_number(), 0) for _ in range(220)]
    rows += [(ui_word(), 0) for _ in range(80)]
    rows += [(label_only(), 0) for _ in range(250)]
    rows += [(plain_number(), 0) for _ in range(300)]

    # remove exact duplicates but keep order
    seen, unique = set(), []
    for text, label in rows:
        if (text, label) not in seen:
            seen.add((text, label))
            unique.append((text, label))
    rng.shuffle(unique)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["text", "label"])
        w.writerows(unique)
    pos = sum(1 for _, l in unique if l == 1)
    print(f"wrote {OUT} rows={len(unique)} sensitive={pos} normal={len(unique) - pos}")


if __name__ == "__main__":
    main()
