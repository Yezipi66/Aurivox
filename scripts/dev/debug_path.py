import os, sys
print("sys.path:")
for p in sys.path:
    print(f"  {p}")
print(f"\nPYTHONPATH env: {os.environ.get('PYTHONPATH', '(not set)')}")
