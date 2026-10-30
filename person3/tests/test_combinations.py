from app.services.combinations import clashes

# Titles from catalog/cache/products.json that the stylist actually paired.
SNEAKER = ("shoes", "ZAPATILLA STRENK VERDE")


def test_polo_with_shorts_is_rejected_whatever_the_polo_is_called():
    for polo in ("Light Terry Polo Sweat, Black", "Sylane Relaxed Light Pile Jersey Polo", "JERSEY CUELLO POLO"):
        problems = clashes([("base", polo), ("bottom", "Short Gujo sable"), SNEAKER], "summer")
        assert any("polo" in p for p in problems), polo


def test_tee_with_shorts_in_summer_is_fine():
    assert clashes([("base", "Reseller KAI FLOWER T-shirt - M/L"), ("bottom", "Short Bodhi bleu nuit"), SNEAKER], "summer") == []


def test_polo_with_trousers_is_fine_even_when_a_brand_says_polo():
    assert clashes([("base", "Polo manga larga blanco"), ("bottom", "Nordmarka Broken Twill Chino"), SNEAKER], "summer") == []
    assert clashes([("base", "Cotton Jersey Trenda Tee, Black"), ("bottom", "POLO RALPH LAUREN | PANTALÓN DENIM RIG"), SNEAKER]) == []


def test_warm_tops_jackets_and_dress_shoes_do_not_go_with_shorts():
    shorts = ("bottom", "Short Bodhi argile")
    assert clashes([("base", "Grace jersey Camille Tee LS, Black/Vanilla Ice"), shorts], "summer")
    assert clashes([("base", "Cotton Jersey Trenda Tee, Black"), ("mid", "Merino Knit Crew"), shorts], "summer")
    assert clashes([("base", "Cotton Jersey Trenda Tee, Black"), ("outer", "Harrington Jacket"), shorts], "summer")
    assert clashes([("base", "Cotton Jersey Trenda Tee, Black"), shorts, ("shoes", "Easy Weejuns Larson Penny Loafers")], "summer")


def test_shorts_only_belong_to_summer():
    assert clashes([("base", "Cotton Jersey Trenda Tee, Black"), ("bottom", "Short Gujo sable")], "autumn") == [
        "shorts (Short Gujo sable) outside summer"
    ]
