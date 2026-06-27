import sys, os
import importlib.machinery
target = r"D:\Project\tts_broker_openai_compat\lib\training\gsv_code"
ff = importlib.machinery.FileFinder(target)
# Try to find the module spec
spec = ff.find_spec("gsv_code")
print("find_spec via FileFinder:", spec)
# Try find_module
try:
    loader = ff.find_module("gsv_code")
    print("find_module:", loader)
except Exception as e:
    print("find_module error:", e)
# List all files in the directory
print("files in gsv_code:", sorted(os.listdir(target)))
# Check __init__.py
init = os.path.join(target, "__init__.py")
print("init.py exists:", os.path.exists(init))
with open(init, "r", encoding="utf-8") as fp:
    content = fp.read()
    print("init.py content:", repr(content[:200]))
