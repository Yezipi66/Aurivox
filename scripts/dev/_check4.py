import sys, os
# Try manually adding the path and importing
sys.path.insert(0, r"D:\Project\tts_broker_openai_compat\lib\training\gsv-code")
print("After insert, sys.path has gsv-code:", any("gsv-code" in p for p in sys.path))
import importlib
try:
    m = importlib.import_module("gsv_code")
    print("import OK:", m.__file__)
except Exception as e:
    print("import FAIL:", e)
# Check if there is a conflicting gsv_code somewhere
for p in sys.path:
    gsv_path = os.path.join(p, "gsv_code")
    if os.path.exists(gsv_path):
        print("Found gsv_code at:", gsv_path, "contents:", os.listdir(gsv_path)[:5])
    gsv_dash = os.path.join(p, "gsv-code")
    if os.path.exists(gsv_dash):
        print("Found gsv-code at:", gsv_dash, "contents:", os.listdir(gsv_dash)[:5])
