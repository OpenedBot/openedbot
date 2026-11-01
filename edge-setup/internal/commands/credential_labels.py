import json, sys
from agent.credential_pool import load_pool
print(json.dumps({"labels": [entry.label for entry in load_pool(sys.argv[1]).entries()]}))
