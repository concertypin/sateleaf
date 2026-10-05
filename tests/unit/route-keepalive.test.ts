import { assert, test } from "vitest";
import { parseProxyRoute } from "@/proxy/route.js";

function route(settings: string) {
    return parseProxyRoute(`/proxy/test-secret/${settings}/example.com/events`);
}

test.concurrent("enables keepalive by default without sending headers early", () => {
    const parsed = route("maximum");
    assert.isTrue(parsed.keepalive);
    assert.isFalse(parsed.earlyKeepalive);
});

test.concurrent("allows opting out of keepalive while preserving PDF settings", () => {
    const parsed = route("balanced,nocache,fontsize=2,nokeepalive");
    assert.isFalse(parsed.keepalive);
    assert.isFalse(parsed.earlyKeepalive);
    assert.isFalse(parsed.cachePdf);
    assert.equal(parsed.mode, "balanced");
    assert.equal(parsed.fontSize, 2);
});

test.concurrent("requires explicit early keepalive opt-in and accepts case-insensitive flags", () => {
    const parsed = route("maximum, EARLYKEEPALIVE");
    assert.isTrue(parsed.keepalive);
    assert.isTrue(parsed.earlyKeepalive);
    assert.isFalse(route("maximum,NOKEEPALIVE").keepalive);
});

test.concurrent("rejects contradictory keepalive flags in either order", () => {
    for (const settings of [
        "maximum,nokeepalive,earlykeepalive",
        "maximum,earlykeepalive,nokeepalive",
    ]) {
        assert.throws(
            () => route(settings),
            "nokeepalive and earlykeepalive cannot be combined"
        );
    }
});

test.concurrent("rejects valued keepalive flags instead of silently interpreting them", () => {
    assert.throws(
        () => route("maximum,nokeepalive=false"),
        "Unknown proxy setting"
    );
    assert.throws(
        () => route("maximum,earlykeepalive=true"),
        "Unknown proxy setting"
    );
});
