from linkverify.robots import is_allowed

ROBOTS = """
User-agent: *
Disallow: /private/
Allow: /private/public-page
Disallow: /*.pdf$
Disallow: /search?

User-agent: Googlebot
Disallow: /no-google/
"""


def test_specific_group_wins_over_star():
    # Googlebot has its own group, so the * rules do not apply to it
    assert is_allowed(ROBOTS, "https://x.com/private/a")[0] is True
    assert is_allowed(ROBOTS, "https://x.com/no-google/a")[0] is False


def test_star_group_rules():
    assert is_allowed(ROBOTS, "https://x.com/private/a", "otherbot")[0] is False
    assert is_allowed(ROBOTS, "https://x.com/private/public-page", "otherbot")[0] is True


def test_wildcards_and_end_anchor():
    assert is_allowed(ROBOTS, "https://x.com/files/report.pdf", "otherbot")[0] is False
    assert is_allowed(ROBOTS, "https://x.com/files/report.pdf?x=1", "otherbot")[0] is True
    assert is_allowed(ROBOTS, "https://x.com/search?q=1", "otherbot")[0] is False


def test_longest_match_and_tie_goes_to_allow():
    text = "User-agent: *\nDisallow: /a\nAllow: /a\n"
    assert is_allowed(text, "https://x.com/a/b")[0] is True


def test_empty_disallow_allows_all():
    assert is_allowed("User-agent: *\nDisallow:\n", "https://x.com/anything")[0] is True


def test_googlebot_image_group_does_not_capture_googlebot():
    text = "User-agent: Googlebot-Image\nDisallow: /\n"
    assert is_allowed(text, "https://x.com/page", "googlebot")[0] is True
