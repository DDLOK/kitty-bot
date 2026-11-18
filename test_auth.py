"""
Test for EZLARP JWT minting.

Run:
    python test_auth.py
"""
import os
import time

# Ensure a predictable env before import
os.environ.setdefault("AUTH_SECRET", "test-secret-abc-123-abcdefghijklmnop")

import jwt
from web_auth import mint_token

AUTH_SECRET = os.environ["AUTH_SECRET"]


def test_payload_shape():
    tok = mint_token(
        user_id="123456789012345678",
        name="olivia",
        avatar="abc123def",
        joined=True,
        auth_secret=AUTH_SECRET,
    )
    payload = jwt.decode(tok, AUTH_SECRET, algorithms=["HS256"], audience="ezlarp")

    assert payload["sub"] == "123456789012345678"
    assert payload["name"] == "olivia"
    assert payload["avatar"] == "abc123def"
    assert payload["joined"] is True
    assert payload["aud"] == "ezlarp"
    assert isinstance(payload["iat"], int)
    assert isinstance(payload["exp"], int)
    assert isinstance(payload["jti"], str) and len(payload["jti"]) >= 16

    # Sanity on the clock
    now = int(time.time())
    assert payload["iat"] <= now <= payload["iat"] + 5, "iat must be ~now"

    # Spec: exp - iat MUST be <= 600 (we use 120)
    assert payload["exp"] - payload["iat"] == 120
    assert payload["exp"] - payload["iat"] <= 600

    print("test_payload_shape: OK")


def test_header_alg():
    tok = mint_token("1", "x", None, False, AUTH_SECRET)
    header = jwt.get_unverified_header(tok)
    assert header["alg"] == "HS256"
    assert header["typ"] == "JWT"
    print("test_header_alg: OK")


def test_name_truncation():
    long_name = "a" * 200
    tok = mint_token("1", long_name, None, False, AUTH_SECRET)
    payload = jwt.decode(tok, AUTH_SECRET, algorithms=["HS256"], audience="ezlarp")
    assert len(payload["name"]) == 64
    print("test_name_truncation: OK")


def test_avatar_none_ok():
    tok = mint_token("1", "x", None, False, AUTH_SECRET)
    payload = jwt.decode(tok, AUTH_SECRET, algorithms=["HS256"], audience="ezlarp")
    assert payload["avatar"] is None
    print("test_avatar_none_ok: OK")


def test_signature_rejects_tamper():
    tok = mint_token("1", "x", None, False, AUTH_SECRET)
    # Flip the last char of the signature
    tampered = tok[:-1] + ("A" if tok[-1] != "A" else "B")
    try:
        jwt.decode(tampered, AUTH_SECRET, algorithms=["HS256"], audience="ezlarp")
        raise AssertionError("tampered signature should have been rejected")
    except jwt.InvalidSignatureError:
        print("test_signature_rejects_tamper: OK")


if __name__ == "__main__":
    test_payload_shape()
    test_header_alg()
    test_name_truncation()
    test_avatar_none_ok()
    test_signature_rejects_tamper()
    print("\nAll tests passed.")
