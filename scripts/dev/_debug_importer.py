import sys, os
target = r"D:\Project\tts_broker_openai_compat\lib\training\gsv_code"
print("target in sys.path:", target in sys.path)
print("target exists:", os.path.exists(target))
print("target isdir:", os.path.isdir(target))
# Check path_hooks
import importlib.machinery
for hook in sys.path_hooks:
    print("path_hook:", hook)
    try:
        finder = hook(target)
        print("  finder:", finder)
    except Exception as e:
        print("  error:", e)
# Check FileFinder
ff = importlib.machinery.FileFinder(target)
print("FileFinder:", ff)
print("files:", list(ff.iter_modules())[:5])
