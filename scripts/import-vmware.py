"""Import API facts and CLI help from the user's installed Workstation tools."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import zipfile

parser = argparse.ArgumentParser()
parser.add_argument('--install-dir', default='C:/Program Files/VMware/VMware Workstation')
args = parser.parse_args()
install = Path(args.install_dir)
out = Path(__file__).resolve().parents[1] / 'src' / 'catalogs'
out.mkdir(parents=True, exist_ok=True)
help_text = subprocess.run([str(install / 'vmrun.exe')], capture_output=True, text=True, check=False).stdout
commands = []
for line in help_text.split('Examples:')[0].splitlines():
    match = re.match(r'^([A-Za-z]\w+)\s{2,}(.+)$', line)
    if match and match[1] not in ['Usage', 'COMMAND', 'POWER', 'SNAPSHOT', 'HOST', 'GUEST', 'GENERAL', 'Template']:
        commands.append(match[1])
version = re.search(r'vmrun version ([\w.]+)', help_text)[1]
(out / 'vmrun-help.json').write_text(json.dumps({'version': version, 'commands': commands}, indent=2) + '\n', encoding='utf-8')
with zipfile.ZipFile(install / 'swagger.zip') as archive:
    raw = archive.read('json/swagger_WS.json')
    spec = json.loads(raw)

def resolve(schema):
    if '$ref' in schema:
        return resolve(spec['definitions'][schema['$ref'].rsplit('/', 1)[1]])
    result = {key: value for key, value in schema.items() if key in ['type', 'enum', 'minimum', 'maximum', 'minLength', 'maxLength', 'required']}
    if 'properties' in schema:
        result['type'] = 'object'
        result['properties'] = {key: resolve(value) for key, value in schema['properties'].items()}
    if 'items' in schema:
        result['items'] = resolve(schema['items'])
    return result

operations = []
for route, methods in spec['paths'].items():
    for method, operation in methods.items():
        if 'operationId' not in operation:
            continue
        parameters = []
        for parameter in operation.get('parameters', []):
            parameters.append({'name': parameter['name'], 'in': parameter['in'], 'required': parameter.get('required', False), 'schema': resolve(parameter.get('schema', parameter)), 'secret': parameter.get('format') == 'password'})
        operations.append({'id': operation['operationId'], 'method': method.upper(), 'path': '/api' + route, 'category': operation['tags'][0], 'parameters': parameters})
catalog = {'source': 'Installed VMware Workstation swagger.zip/json/swagger_WS.json', 'sha256': hashlib.sha256(raw).hexdigest(), 'operations': operations}
(out / 'rest.json').write_text(json.dumps(catalog, indent=2) + '\n', encoding='utf-8')
print(f'Imported vmrun {version}: {len(commands)} commands; REST: {len(operations)} operations.')
