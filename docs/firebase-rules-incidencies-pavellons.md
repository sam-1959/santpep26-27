# Regla Firebase per a les incidències de pavellons

Afegiu el contingut de `firebase-rules-incidencies-pavellons.json` dins de l'objecte `rules` existent de Firebase Realtime Database; no substituïu la resta de regles.

La regla permet que qualsevol persona creï una incidència nova, però no pot llegir les incidències ni modificar-ne o eliminar-ne cap. La seva consulta queda reservada als usuaris autenticats.
