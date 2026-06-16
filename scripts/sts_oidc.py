#!/usr/bin/env python3
"""Obtain Alibaba Cloud STS credentials via OIDC (GitHub Actions).

Usage:
    python3 scripts/sts_oidc.py \
        --role-arn <ROLE_ARN> \
        --oidc-provider-arn <OIDC_PROVIDER_ARN> \
        --session-name <SESSION_NAME>

Environment:
    ID_TOKEN  – GitHub Actions OIDC token (set by the workflow step)

Output (JSON to stdout):
    { "AccessKeyId": "...", "AccessKeySecret": "...", "SecurityToken": "..." }
"""

import argparse
import json
import os
import sys


def main():
    parser = argparse.ArgumentParser(description="STS AssumeRoleWithOIDC")
    parser.add_argument("--role-arn", required=True)
    parser.add_argument("--oidc-provider-arn", required=True)
    parser.add_argument("--session-name", required=True)
    parser.add_argument("--duration-seconds", type=int, default=3600)
    args = parser.parse_args()

    id_token = os.environ.get("ID_TOKEN", "")
    if not id_token:
        print("ERROR: ID_TOKEN environment variable is not set", file=sys.stderr)
        sys.exit(1)

    try:
        from alibabacloud_sts20150401.client import Client as StsClient
        from alibabacloud_sts20150401 import models as sts_models
        from alibabacloud_tea_openapi import models as open_api_models
    except ImportError as e:
        print(f"ERROR: Missing dependency: {e}", file=sys.stderr)
        print("Run: pip install alibabacloud_sts20150401", file=sys.stderr)
        sys.exit(1)

    config = open_api_models.Config(
        access_key_id="",
        access_key_secret="",
        credential=open_api_models.CredentialConfig(
            bearer_token=id_token,
        ),
        region_id="cn-guangzhou",
    )
    client = StsClient(config=config)

    req = sts_models.AssumeRoleWithOIDCRequest(
        role_arn=args.role_arn,
        oidc_provider_arn=args.oidc_provider_arn,
        role_session_name=args.session_name,
        duration_seconds=args.duration_seconds,
    )

    try:
        resp = client.assume_role_with_oidc(req)
    except Exception as e:
        print(f"ERROR: STS AssumeRoleWithOIDC failed: {e}", file=sys.stderr)
        sys.exit(1)

    creds = resp.body.credentials
    result = {
        "AccessKeyId": creds.access_key_id,
        "AccessKeySecret": creds.access_key_secret,
        "SecurityToken": creds.security_token,
    }
    print(json.dumps(result))


if __name__ == "__main__":
    main()
