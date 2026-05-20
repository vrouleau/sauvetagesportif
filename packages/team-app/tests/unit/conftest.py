"""Unit test conftest — no Docker stack required.

Overrides the session-scoped 'stack' fixture from the parent conftest
so unit tests can run without Docker.
"""
import pytest


@pytest.fixture(scope="session", autouse=True)
def stack():
    """No-op: unit tests don't need the Docker stack."""
    yield
