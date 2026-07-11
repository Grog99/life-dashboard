# Import finansów i automatyzacja

## Co działa teraz

Puls importuje wyciągi CSV bez przechowywania loginu ani hasła do banku. Kreator:

1. wykrywa separator oraz polskie i angielskie formaty kwot,
2. sugeruje mapowanie kolumn,
3. waliduje maksymalnie 10 000 wierszy,
4. pokazuje pierwsze 50 operacji przed zapisem,
5. tworzy stabilny fingerprint uwzględniający pozycję identycznych operacji,
6. pomija rekordy obecne po ponownym imporcie.

Import historii nie zmienia pola „aktualne saldo” rachunku, dzięki czemu stare operacje nie są liczone drugi raz.

## Jak trudna jest automatyzacja

| Wariant | Trudność | Koszt / ryzyko | Rekomendacja |
|---|---:|---|---|
| Zapamiętany profil CSV dla konkretnego banku | niska | brak dostępu do konta; nadal ręczne pobranie pliku | najlepszy następny krok |
| Obserwowany katalog w homelabie | niska–średnia | trzeba bezpiecznie dostarczać pliki na serwer | dobre dla cyklicznych eksportów |
| CAMT.053 / MT940 | średnia | różnice między bankami, ale format jest bardziej stabilny niż CSV | warto dodać po poznaniu banków |
| Open Banking przez agregatora PSD2 | wysoka | opłaty, zgody OAuth, limity i zależność od dostawcy | opcjonalnie dla pełnej automatyzacji |
| Logowanie/scraping serwisu banku | bardzo wysoka | kruche, ryzykowne i często niezgodne z regulaminem | Puls tego nie implementuje |

Bezpośredni PSD2 jest w praktyce przeznaczony dla uprawnionych podmiotów, dlatego mały self-hosted projekt zwykle integruje się przez licencjonowanego agregatora. Najrozsądniejszy plan to najpierw dodać profile eksportu dla używanych banków, potem CAMT.053, a dopiero na końcu rozważyć płatnego dostawcę Open Banking.

## Dane potrzebne do presetów

Do przygotowania automatycznego profilu wystarczy zanonimizowany nagłówek i kilka przykładowych wierszy eksportu — bez numeru rachunku, prawdziwych nazw kontrahentów i kwot. Przydatna jest też nazwa banku oraz informacja, czy udostępnia CAMT.053 albo MT940.

Kwoty w aplikacji są przechowywane jako całkowite wartości najmniejszej jednostki waluty (`amountMinor`), nie jako liczby zmiennoprzecinkowe.

