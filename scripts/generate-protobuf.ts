import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import protobuf from 'protobufjs';

function jsonContract(source: string): Record<string, Record<string, string>> {
  const imports: Record<string, string> = {};
  const result: Record<string, Record<string, string>> = {};
  const importBlock = /^import \(([\s\S]*?)^\)/m.exec(source)?.[1] ?? '';
  for (const entry of importBlock.matchAll(/^\s*(?:(\w+)\s+)?"([^"]+)"/gm)) {
    const path = entry[2]!;
    imports[entry[1] ?? path.split('/').at(-1)!] = path.replaceAll('/', '.');
  }
  for (const declaration of source.matchAll(/^type (\w+) struct \{([\s\S]*?)^\}/gm)) {
    const fields: Record<string, string> = {};
    for (const field of declaration[2]!.matchAll(/^\s*(\w+)[^\n`]*`([^`]+)`/gm)) {
      const tag = field[2]!;
      const number = /\bprotobuf:"[^,]+,(\d+),/.exec(tag)?.[1];
      const name = /\bjson:"([^",]*)/.exec(tag)?.[1] ?? field[1]!;
      if (number !== undefined) fields[number] = name;
    }
    result[declaration[1]!] = fields;
  }
  for (const reference of source.matchAll(/^type (\w+) (\w+)\.(\w+)\s*$/gm)) {
    result[reference[1]!] = { '@': `${imports[reference[2]!]}.${reference[3]}` };
  }
  return result;
}

// Official source files at the same module pin as kubectl and command metadata.
const pins: Record<string, string> = {
  'api/core/v1': 'dd6cf89d7df51a09d62b9c57f645c90956195df301c3c62d204b569821599502',
  'api/apps/v1': '2c8cfc9a8490a7e5f6bbc03c55b2bcf25bcebeaaf0c1a5beb9f42b1a9ed8bb8a',
  'api/certificates/v1': 'a64a67932d9d0ebfd0bba14848d766e49bc6213aa794d2ba48c24ebc5837f214',
  'api/authentication/v1': 'd7c49084083c28293edd9f4328d0f7cddee18b31b8ccb0686c7f64fa48e2eb43',
  'api/authorization/v1': 'f48b383d771bc5a70137b687de7a64399bc3ddb5716611e98fa93b88ad1c8ac7',
  'api/autoscaling/v1': '641e11298921cb83e8369f83a18c45b3cd7f30ab8ad533eb74729c1e1b0fdc52',
  'api/autoscaling/v2': 'b1cad9eddb573fa6beeb2ca6882cab13d1667ddc4de6e3f587a8f5f182c04b88',
  'api/policy/v1': 'f98d4b791c5c13439d7e70021b636c5f0a3b95bff04c11c5c0cb0c511851a6c2',
  'api/rbac/v1': 'b189242e71eb199832c8d5de0e565f25b6f1f05586ba4d3aef14c3ea3790d65b',
  'api/batch/v1': 'f9d6b2031d1054ddcc8b3b428f3ba117f791c89c94fa9aca101b082086f80d08',
  'api/networking/v1': 'f2418775cd71ec612f059b74e8dac85c1fd1932e4309f7cea174e1e0216c7493',
  'api/scheduling/v1': '7d85165851c7c4d5485a2a9a21ee2251fde15eb9f632dbe08bce82af60fa74ef',
  'apimachinery/pkg/runtime': '19a098984ebde051f717387ef35ae0069104eab9c0534a4bb37470ea1d47fcc9',
  'apimachinery/pkg/runtime/schema': 'f6c8cc582d36e639e022c9edc2faf213ab16fe07045fabf54f5edc2241eda3e5',
  'apimachinery/pkg/apis/meta/v1': 'ffc98d709e9d139e60460ee7a4fd526baf3baf1176a51859a7ba092eb26875cc',
  'apimachinery/pkg/util/intstr': '7988d488df2aa72bc5fb7de6094e372f5aef03d7d70819ba777a8e8760dd9091',
  'apimachinery/pkg/api/resource': 'b952ca7037ea1fef76285a8b20597da7b18f2f789662dcf87717304da58a53b3',
};
const cache = execFileSync('go', ['env', 'GOMODCACHE'], { encoding: 'utf8' }).trim();
const jsonPins: Record<string, [string, string]> = {
  'api/core/v1': ['types.go', 'ecc3289051e4c011c8d15089f820d1a03ba7a5400719a7abda0ce58caf33f842'],
  'api/apps/v1': ['types.go', 'e04a57ff9c6a3aa88a1a60e9bf5ab475667a398ba0158bcafe2345bd089e60b9'],
  'api/certificates/v1': ['types.go', '0829a13450b01658eeaaefc4b2d34ae42db3ea468c066617ade60cb73ec72e5e'],
  'api/authentication/v1': ['types.go', 'd4df2a615df545ea4fde358129fae8dfb2e26774772a7689ea5a21f74882f920'],
  'api/authorization/v1': ['types.go', '19e3b7d9f84e5ba37d3a6965bfc5006b6586b6a7b3c22ddc6d1a4cda365426b6'],
  'api/autoscaling/v1': ['types.go', '2028c2e82e45e060d41e878487a72bfa50a5f136344579b30e689d9919cb88e3'],
  'api/autoscaling/v2': ['types.go', '9ef3cb1198386848f273a07ed8ce2d5240596446498ff0a0edf4876ad8b19cd0'],
  'api/policy/v1': ['types.go', '93e994786092ae039a63002059c2c0be0ab5425496224ab4b013d62f2496d42c'],
  'api/rbac/v1': ['types.go', '199dc7d9bab6c0ab762017eab7a39a12f965a79861926d5601713a874bd22152'],
  'api/batch/v1': ['types.go', 'b51be02a14925c84d0727b71f2a8221676251d32a0e6122924ef62b82cc2e461'],
  'api/networking/v1': ['types.go', '02e983aa9d59d4807c1d447645bf96dae3b997aba7f58a0be6f149553a5084bd'],
  'api/scheduling/v1': ['types.go', '0596b85a91ea472006352373d0b77025f39d5dfc0095a18628341f8a8a4d8fa8'],
  'apimachinery/pkg/runtime': ['types.go', 'a9a649906894028fb616998f054a3ae1dd101d9131c1f565132fc32fc3cb1173'],
  'apimachinery/pkg/apis/meta/v1': ['types.go', '1288e296b31cd87faad841a81a712cd7dbde4d72b877c39f136dad9373e5692f'],
  'apimachinery/pkg/util/intstr': ['intstr.go', '38d62ef6bae34442496e0fa7b84e2b7398fed8ac9a0863d24ddcbc50eea50e32'],
  'apimachinery/pkg/api/resource': ['quantity.go', 'e8a6e80a3d3dd43f5c6d8edd2accbfccaf6db6792654d3bb6e0c44830a27af54'],
};
const root = new protobuf.Root();
const contracts: Record<string, Record<string, string>> = {};
for (const [name, digest] of Object.entries(pins)) {
  const [module, ...path] = name.split('/');
  const source = readFileSync(join(cache, `k8s.io/${module}@v0.32.2`, ...path, 'generated.proto'));
  if (createHash('sha256').update(source).digest('hex') !== digest) throw new Error(`Unreviewed protobuf source: ${name}`);
  protobuf.parse(source.toString(), root, { keepCase: true });
  const contract = jsonPins[name];
  if (contract) {
    const filename = join(cache, `k8s.io/${module}@v0.32.2`, ...path, contract[0]);
    if (createHash('sha256').update(readFileSync(filename)).digest('hex') !== contract[1]) throw new Error(`Unreviewed JSON contract: ${name}`);
    const mapping = jsonContract(readFileSync(filename, 'utf8'));
    for (const [type, fields] of Object.entries(mapping)) contracts[`k8s.io.${name.replaceAll('/', '.')}.${type}`] = fields;
  }
}
root.resolveAll();
for (const [name, contract] of Object.entries(contracts)) {
  const type = root.lookup(name);
  if (!(type instanceof protobuf.Type)) continue;
  const fields = contract['@'] ? contracts[contract['@']]! : contract;
  for (const field of type.fieldsArray) {
    const jsonName = fields[String(field.id)];
    if (jsonName !== undefined) field.setOption('kubernetesJsonName', jsonName);
    else if (!['Quantity', 'QuantityValue', 'Time', 'MicroTime', 'RawExtension', 'FieldsV1', 'ExtraValue'].includes(type.name)) throw new Error(`Missing JSON contract: ${type.fullName}.${field.name}`);
  }
}
const content = `// Generated by scripts/generate-protobuf.ts from checksummed official v0.32.2 sources.\nimport type { INamespace } from 'protobufjs';\nexport const protobufSchema = JSON.parse(${JSON.stringify(JSON.stringify(root.toJSON()))}) as INamespace;\n`;
const destination = new URL('../src/protobuf-schema.ts', import.meta.url);
if (process.argv.includes('--check')) {
  if (readFileSync(destination, 'utf8') !== content) throw new Error('Stale Kubernetes protobuf schema.');
} else writeFileSync(destination, content);
