// SSM Parameter Store からの秘密取得 (sidecar HMAC secret / RCON password)。
//
// EC2 instance role が `ssm:GetParameter` を持っている前提 (Launch Template `gs-game-server`
// の IAM profile に AmazonSSMManagedInstanceCore policy が付いている)。
//
// AWS SDK v3 の `@aws-sdk/client-ssm` は credential provider chain を自動で解決する
// (環境変数 → IMDS など)。EC2 上では IMDSv2 の instance role から自動取得される。

import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

const region = process.env['AWS_REGION'] ?? 'ap-northeast-1';
const client = new SSMClient({ region });

export async function getSecureParameter(name: string): Promise<string> {
  const cmd = new GetParameterCommand({ Name: name, WithDecryption: true });
  const result = await client.send(cmd);
  const value = result.Parameter?.Value;
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`SSM parameter "${name}" not found or empty`);
  }
  return value;
}
