# Sillytavern-Character-Expressions-Helper
A small helper plugin to control the default character expressions extension in sillytavern. Needs my custom preset to work.

Basically, what the chat completion preset does is fetch available sprites from the default character expressions extension, and determine the form the character is in. Form is basically the subfolders anointed through the helper.

<div align="center">
  <img width="477" height="448" alt="Screenshot 2026-11-16 144712" src="https://github.com/user-attachments/assets/0e911ded-44db-453b-9b76-4372701afa41" />
</div>

Forms are denoted as letters, A is basically fallback so character root folder, whereas B,C and D are subfolder names

# Guide:

1. Sprites folder has a copy of default sprites.js and the new one you will overwrite the original sprites.js with which is located in src/endpoints. Don't forget to keep a backup of the original sprites.js
2. Install the extension with the github repo link
3. In default Character Expressions Extension set Classifier API to None so there are no API calls and you are set.

<div align="center">
  <img width="1010" height="977" alt="Screenshot 2026-11-16 144500" src="https://github.com/user-attachments/assets/8fc2e37b-8e64-4b35-8151-3f29a721f543" />
</div>

That's literally it. No extra api calls except generating the base response, no lag or bugs, just instant sprites.

Below is the link to my chat completion preset:
https://drive.google.com/drive/folders/12PKmpHMBlhv4zWRBtAY0bYV_uIdcSzAp?usp=sharing
