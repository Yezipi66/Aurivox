import os, sys

# Set PYTHONPATH before any imports
project = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
gsv_code_dir = os.path.join(project, "lib", "training", "gsv_code")
os.environ['PYTHONPATH'] = os.path.join(project, "lib", "training")
os.environ['PYTHONUNBUFFERED'] = '1'

# Now test
import importlib.util
spec = importlib.util.find_spec("gsv_code")
print("find_spec:", spec)

from gsv_code import utils
print("import gsv_code OK!")
