# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Vincent Rouleau <https://github.com/vrouleau/sauvetagesportif>
#
# This file is part of Sauvetage Sportif.
#
# Sauvetage Sportif is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# Sauvetage Sportif is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
# GNU Affero General Public License for more details.
#
# You should have received a copy of the GNU Affero General Public License
# along with Sauvetage Sportif. If not, see <https://www.gnu.org/licenses/>.

"""Generate icon.ico from icon.png with multiple sizes for Windows."""
from PIL import Image
from pathlib import Path

src = Path("packages/meet-app/resources/icon.png")
dst = Path("packages/meet-app/resources/icon.ico")

img = Image.open(src)
print(f"Source: {img.size[0]}x{img.size[1]}")

# Windows ico should have these sizes
sizes = [(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]

img.save(dst, format='ICO', sizes=sizes)
print(f"Created {dst} with sizes: {[f'{w}x{h}' for w,h in sizes]}")