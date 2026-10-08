"""
Inspects a DASH AI debug APK without printing any Firebase value: reports only presence, length and
whether each value matches the format the Gradle build enforces. Usage: python -I inspect_apk.py APK
"""
import re
import subprocess
import sys
from pathlib import Path

from androguard.core.apk import APK
from androguard.core.dex import DEX
from loguru import logger

logger.remove()  # androguard is chatty

apk_path = sys.argv[1]
apk = APK(apk_path)

print("== Package and install metadata ==")
print("package:", apk.get_package())
print("versionName / versionCode:", apk.get_androidversion_name(), "/", apk.get_androidversion_code())
print("minSdk / targetSdk:", apk.get_min_sdk_version(), "/", apk.get_target_sdk_version())
manifest = apk.get_android_manifest_axml().get_xml_obj()
ns = "{http://schemas.android.com/apk/res/android}"
app_el = manifest.find("application")
print("debuggable:", app_el.get(ns + "debuggable"))
print("valid APK (androguard parse):", apk.is_valid_APK())

print("\n== Signing ==")
print("v1 (JAR) signed:", apk.is_signed_v1(), "| v2 signed:", apk.is_signed_v2(), "| v3 signed:", apk.is_signed_v3())
for cert in apk.get_certificates():
    print("certificate subject:", cert.subject.human_friendly, "| SHA-256:", cert.sha256_fingerprint.replace(" ", "")[:16] + "…")
tool = Path(sys.executable).parent / "apksigtool"
if tool.exists():
    verify = subprocess.run([str(tool), "verify", apk_path], capture_output=True, text=True)
    print("apksigtool verify exit code:", verify.returncode, "(0 = signatures verify)")
    if verify.returncode != 0:
        print((verify.stdout + verify.stderr).strip()[:2000])

print("\n== Push (FCM) wiring in the manifest ==")
print("POST_NOTIFICATIONS permission:", "android.permission.POST_NOTIFICATIONS" in apk.get_permissions())
messaging_services = []
for svc in app_el.findall("service"):
    for flt in svc.findall("intent-filter"):
        for action in flt.findall("action"):
            if action.get(ns + "name") == "com.google.firebase.MESSAGING_EVENT":
                messaging_services.append(svc.get(ns + "name"))
print("services handling com.google.firebase.MESSAGING_EVENT:", messaging_services)
for meta in app_el.findall("meta-data"):
    name = meta.get(ns + "name") or ""
    if name.startswith("firebase_"):
        print("meta-data", name, "=", meta.get(ns + "value"))
print("google-services.json resources present (google_app_id):", b"google_app_id" in apk.get_file("resources.arsc"))

print("\n== Firebase client configuration compiled into BuildConfig (values NOT printed) ==")
formats = {
    "FIREBASE_PROJECT_ID": r"^[a-z0-9-]{4,40}$",
    "FIREBASE_APP_ID": r"^1:[0-9]+:android:[0-9a-f]+$",
    "FIREBASE_API_KEY": r"^[A-Za-z0-9_-]{20,60}$",
    "FIREBASE_SENDER_ID": r"^[0-9]{6,20}$",
}
found = {}
for name in apk.get_dex_names():
    dex = DEX(apk.get_file(name))
    for cls in dex.get_classes():
        if cls.get_name() != "Lcom/dashworldng/ai/BuildConfig;":
            continue
        for field in cls.get_fields():
            if field.get_name() in formats:
                init = field.get_init_value()
                found[field.get_name()] = None if init is None else str(init.get_value())
ok = True
for key, pattern in formats.items():
    value = found.get(key)
    present = value is not None
    nonempty = bool(value)
    matches = bool(value) and re.match(pattern, value) is not None
    ok = ok and matches
    print(f"{key}: field present={present}, non-empty={nonempty}, length={len(value) if value else 0}, matches the enforced format={matches}")
# The app id and sender id must agree (the sender id is the project number inside the app id).
app_id, sender = found.get("FIREBASE_APP_ID") or "", found.get("FIREBASE_SENDER_ID") or ""
print("app id's project number equals the sender id:", bool(app_id) and app_id.split(":")[1:2] == [sender])
print("API key has the Google API key shape (AIza…, 39 chars):", bool(re.match(r"^AIza[0-9A-Za-z_-]{35}$", found.get("FIREBASE_API_KEY") or "")))
print("\nRESULT: Firebase client configuration complete:", ok)
