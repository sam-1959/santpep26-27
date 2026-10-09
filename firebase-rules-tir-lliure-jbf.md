# Regla Firebase · Tir lliure JBF

Integra el bloc següent dins de les regles de Realtime Database existents. Permet llegir el seguiment i crear nous entrenaments, però no modificar ni eliminar entrades ja desades.

```json
"freeThrowTrainings": {
  "season-26-27": {
    "JBF": {
      ".read": true,
      "$entryId": {
        ".write": "!data.exists() && newData.hasChildren(['id', 'teamKey', 'trainingDate', 'players', 'createdAt'])"
      }
    }
  }
}
```
