from app.core.security import decrypt_token, encrypt_token


def test_encrypt_decrypt_round_trip():
    plaintext = "super-secret-graph-token"

    ciphertext = encrypt_token(plaintext)

    assert ciphertext != plaintext
    assert decrypt_token(ciphertext) == plaintext
