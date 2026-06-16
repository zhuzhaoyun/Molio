#!/usr/bin/env python3
"""Obtain Alibaba Cloud STS credentials via OIDC (GitHub Actions).

Uses alibabacloud_credentials with type='oidc_role_arn' to automatically
exchange a GitHub Actions OIDC token for temporary STS credentials.

Usage:
    export ID_TOKEN=<github-oidc-token>
    python3 scripts/sts_oidc.py \
        --role-arn <ROLE_ARN> \
        --oidc-provider-arn <OIDC_PROVIDER_ARN> \
        --session-name <SESSION_NAME>

Output (JSON to stdout):
    { "AccessKeyId": "...", "AccessKeySecret": "...", "SecurityToken": "..." }
"""

import argparse
import json
import os
import sys
import tempfile


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

    # Write OIDC token to a temp file (alibabacloud_credentials reads from file)
    token_file = os.path.join(tempfile.gettempdir(), "github_oidc_token")
    with open(token_file, "w") as f:
        f.write(id_token)

    try:
        from alibabacloud_credentials.client import Client as CredClient
        from alibabacloud_credentials.models import Config as CredConfig
    except ImportError as e:
        print(f"ERROR: Missing dependency: {e}", file=sys.stderr)
        print("Run: pip install alibabacloud_credentials", file=sys.stderr)
        sys.exit(1)

    # Use OIDC credential type — automatically calls AssumeRoleWithOIDC
    cred_config = CredConfig(
        type="oidc_role_arn",
        oidc_provider_arn=args.oidc_provider_arn,
        role_arn=args.role_arn,
        oidc_token_file_path=token_file,
        role_session_name=args.session_name,
        role_session_expiration=args.duration_seconds,
    )

    try:
        cred_client = CredClient(config=cred_config)
        # get_credential() triggers the OIDC → STS exchange
        credential = cred_client.get_credential()
    except Exception as e:
        print(f"ERROR: Failed to obtain STS credentials: {e}", file=sys.stderr)
        sys.exit(1)

    result = {
        "AccessKeyId": credential.access_key_id,
        "AccessKeySecret": credential.access_key_secret,
        "SecurityToken": credential.security_token,
    }
    print(json.dumps(result))


if __name__ == "__main__":
    main()
